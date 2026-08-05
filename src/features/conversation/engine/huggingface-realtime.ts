/**
 * Hugging Face realtime WebSocket client.
 *
 * The deployed HF backend is OpenAI-Realtime-compatible at the JSON event
 * layer, but it transports audio as base64 PCM over a WebSocket instead of
 * exposing a WebRTC media peer. This client keeps the rest of the mobile
 * engine's contract unchanged:
 *
 *   robot mic MediaStreamTrack -> 16 kHz PCM append events -> HF backend
 *   HF output_audio.delta PCM  -> MediaStreamTrack        -> robot speaker
 *
 * Tool calls, transcripts, and vision context injections keep using the
 * OpenAI-compatible realtime event names.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import {
  HF_REALTIME_CONNECTION_MODE,
  HF_REALTIME_SESSION_PROXY_URL,
  HF_REALTIME_WS_URL,
} from "@/shared/env";

import { readHfTokenFromStorage } from "./hf-token";

const HF_SAMPLE_RATE = 16_000;
const INPUT_BUFFER_SIZE = 4096;
const WS_BUFFERED_AMOUNT_LIMIT = 512 * 1024;
const OUTPUT_START_LEAD_S = 0.04;
const OUTPUT_DRAIN_PAD_MS = 250;
const RESPONSE_DONE_FALLBACK_MS = 5_000;
// Backstop for the "tool call in flight" processing hold. When the
// model calls a tool, the tool-call response completes (`response.done`)
// long before the follow-up spoken response arrives - in between we run
// the tool (e.g. the `look` VLM round-trip, ~1-2 s) and then fire
// `response.create`. We keep the status on `processing` across that gap
// so the orb keeps reading "thinking" instead of flashing back to idle.
// This timer only fires if the follow-up response never materialises
// (network hiccup), so we never get stuck showing "thinking" forever.
// Sized above the vision VLM timeout (8 s) plus follow-up headroom.
const TOOL_CALL_PROCESSING_FALLBACK_MS = 15_000;
// The realtime session allocator Space occasionally answers with a gateway
// timeout (504) or other 5xx under load. A single short retry turns most of
// those transient blips into a successful allocation instead of a
// user-visible startup failure. A 4xx is a real rejection and never retried.
const ALLOCATOR_MAX_ATTEMPTS = 2;
const ALLOCATOR_RETRY_BACKOFF_MS = 400;
const MOBILE_CLIENT_USER_AGENT = "reachy-mini-mobile-app";
const REACHY_AUTHORIZATION_HEADER = "X-Reachy-Mini-Authorization";

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "user-speaking"
  | "processing"
  | "ai-speaking"
  | "closed"
  | "error";

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface HuggingFaceRealtimeOptions {
  getHfToken?: () => string | null;
  /** Stable daemon-reported robot id. Used only by the deployed allocator. */
  hardwareId?: string | null;
  voice: string;
  instructions: string;
  inputTrack: MediaStreamTrack;
  tools?: RealtimeTool[];
  /**
   * ISO 639-1 code (e.g. `"en"`, `"fr"`) passed to the input
   * transcription model so it doesn't guess the spoken language.
   * Sourced from the app-wide conversation-language preference;
   * defaults to English when omitted.
   */
  transcriptionLanguage?: string;
}

type EventMap = {
  status: { status: RealtimeStatus };
  outputTrack: { track: MediaStreamTrack };
  transcript: { role: "user" | "assistant"; text: string; partial: boolean };
  toolCall: RealtimeToolCall;
  error: { error: unknown };
};

type Listener<K extends keyof EventMap> = (detail: EventMap[K]) => void;

export interface HfRealtimeUrlParts {
  websocketUrl: string;
  websocketBaseUrl: string;
  connectQuery: Record<string, string>;
  host: string | null;
  port: number | null;
  hasRealtimePath: boolean;
}

interface HfSessionAllocatorPayload {
  connect_url?: unknown;
  session_id?: unknown;
}

export class HuggingFaceRealtimeClient {
  private ws: WebSocket | null = null;
  private inputStreamer: PcmInputStreamer | null = null;
  private outputPlayer: PcmOutputTrack | null = null;
  private listeners: { [K in keyof EventMap]?: Set<Listener<K>> } = {};
  private status: RealtimeStatus = "idle";
  private intentionalClose = false;
  private responseDoneFallbackTimer: number | null = null;
  // True between a tool call being dispatched and its follow-up
  // response starting, so `response.done` for the tool-call response
  // itself doesn't bounce the status back to idle mid-round-trip.
  private toolCallPendingResponse = false;
  private toolCallSafetyTimer: number | null = null;

  readonly options: HuggingFaceRealtimeOptions;

  constructor(options: HuggingFaceRealtimeOptions) {
    this.options = options;
  }

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners[event] as Set<Listener<K>> | undefined;
    if (!set) {
      set = new Set<Listener<K>>();
      (this.listeners as Record<string, Set<Listener<K>>>)[event] = set;
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  private emit<K extends keyof EventMap>(event: K, detail: EventMap[K]): void {
    const set = this.listeners[event] as Set<Listener<K>> | undefined;
    if (!set) return;
    for (const listener of set) {
      try {
        listener(detail);
      } catch (err) {
        console.error("[hf-realtime] listener error:", err);
      }
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", { status });
  }

  private markAudible(): void {
    // The follow-up response is now producing audio, so any pending
    // tool-call processing hold is satisfied - release its backstop.
    this.clearToolCallProcessingHold();
    if (this.status === "ai-speaking") return;
    if (this.status === "closed" || this.status === "error") return;
    this.setStatus("ai-speaking");
  }

  /** Arm the "tool call in flight" hold: keep `processing` until the
   *  follow-up response speaks (or the backstop fires). */
  private beginToolCallProcessingHold(): void {
    this.toolCallPendingResponse = true;
    if (this.toolCallSafetyTimer !== null) {
      window.clearTimeout(this.toolCallSafetyTimer);
    }
    this.toolCallSafetyTimer = window.setTimeout(() => {
      this.toolCallSafetyTimer = null;
      this.toolCallPendingResponse = false;
      // Only force idle if we're still parked on `processing` waiting
      // for a follow-up that never came.
      if (this.status === "processing") {
        console.warn(
          "[hf-realtime] tool-call follow-up never arrived; leaving processing",
        );
        this.setStatus("connected");
      }
    }, TOOL_CALL_PROCESSING_FALLBACK_MS);
  }

  private clearToolCallProcessingHold(): void {
    this.toolCallPendingResponse = false;
    if (this.toolCallSafetyTimer !== null) {
      window.clearTimeout(this.toolCallSafetyTimer);
      this.toolCallSafetyTimer = null;
    }
  }

  async connect(): Promise<void> {
    if (this.ws) throw new Error("Already connected");
    this.intentionalClose = false;
    this.setStatus("connecting");

    const hfToken =
      this.options.getHfToken?.() ?? readHfTokenFromStorage() ?? null;
    const websocketUrl = await resolveHfRealtimeWebSocketUrl(
      hfToken,
      this.options.hardwareId,
    );

    const outputPlayer = new PcmOutputTrack(HF_SAMPLE_RATE);
    this.outputPlayer = outputPlayer;
    this.emit("outputTrack", { track: outputPlayer.track });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(websocketUrl);
      this.ws = ws;
      let opened = false;
      let startupSettled = false;
      let startupRejected = false;

      const rejectStartup = (err: Error): void => {
        if (startupSettled) return;
        startupSettled = true;
        startupRejected = true;
        cleanupStartupListeners();
        try {
          ws.close();
        } catch {
          // ignored
        }
        this.ws = null;
        this.outputPlayer?.close();
        this.outputPlayer = null;
        this.setStatus("error");
        reject(err);
      };

      const buildCloseError = (event: CloseEvent): Error => {
        const reason = event.reason ? `: ${event.reason}` : "";
        return new Error(
          `Hugging Face realtime websocket closed (${event.code})${reason}`,
        );
      };

      const cleanupStartupListeners = (): void => {
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("error", handleStartupError);
      };

      const handleStartupError = (): void => {
        if (opened) return;
        rejectStartup(new Error("Hugging Face realtime websocket failed to open"));
      };

      const handleOpen = (): void => {
        opened = true;
        cleanupStartupListeners();
        try {
          this.sendEvent({
            type: "session.update",
            session: buildHfSessionConfig({
              instructions: this.options.instructions,
              voice: this.options.voice,
              tools: this.options.tools ?? [],
              transcriptionLanguage: this.options.transcriptionLanguage,
            }),
          });

          const streamer = new PcmInputStreamer({
            track: this.options.inputTrack,
            sendPcm: (pcm) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (ws.bufferedAmount > WS_BUFFERED_AMOUNT_LIMIT) return;
              this.sendEvent({
                type: "input_audio_buffer.append",
                audio: pcm16ToBase64(pcm),
              });
            },
          });
          streamer.start();
          this.inputStreamer = streamer;
          this.setStatus("connected");
          startupSettled = true;
          resolve();
        } catch (err) {
          rejectStartup(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.addEventListener("open", handleOpen);
      ws.addEventListener("error", handleStartupError);
      ws.addEventListener("message", (event) => this.handleMessage(event));
      ws.addEventListener("error", (event) => {
        if (!opened || this.intentionalClose) return;
        console.error("[hf-realtime] websocket error:", event);
        this.emit("error", {
          error: new Error("Hugging Face realtime websocket error"),
        });
        this.setStatus("error");
      });
      ws.addEventListener("close", (event) => {
        if (this.intentionalClose) return;
        const err = buildCloseError(event);
        if (!startupSettled) {
          rejectStartup(err);
          return;
        }
        if (startupRejected) return;
        this.emit("error", { error: err });
        this.setStatus("error");
      });
    });
  }

  sendEvent(event: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
  }

  sendToolResponse(callId: string, output: unknown): void {
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: outputStr,
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.clearResponseDoneFallback();
    this.clearToolCallProcessingHold();

    this.inputStreamer?.stop();
    this.inputStreamer = null;

    this.outputPlayer?.close();
    this.outputPlayer = null;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignored
      }
    }
    this.setStatus("closed");
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;

    let payload: { type?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (typeof payload.type === "string") {
      console.debug("[hf-realtime] event:", payload.type);
    }

    switch (payload.type) {
      case "session.created":
      case "session.updated":
        break;

      case "input_audio_buffer.speech_started":
        this.setStatus("user-speaking");
        break;

      case "input_audio_buffer.speech_stopped":
        if (this.status === "user-speaking") this.setStatus("processing");
        break;

      case "response.created":
      case "response.output_item.added":
        if (this.status === "connected" || this.status === "user-speaking") {
          this.setStatus("processing");
        }
        break;

      case "response.audio.delta":
      case "response.output_audio.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) {
          this.clearResponseDoneFallback();
          this.outputPlayer?.appendBase64Pcm(delta);
        }
        this.markAudible();
        break;
      }

      case "response.content_part.added": {
        const part = payload.part as { type?: string } | undefined;
        if (part?.type === "audio" || part?.type === "output_audio") {
          this.markAudible();
        }
        break;
      }

      case "response.output_audio.done":
      case "response.audio.done":
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.markConnectedAfterOutputDrain();
        break;

      case "response.done":
      case "response.cancelled":
        if (this.status === "ai-speaking") {
          this.markConnectedAfterOutputDrain();
        } else if (this.status === "processing") {
          // A tool-call response completes (no audio) well before its
          // follow-up spoken response: `sendToolResponse` always fires
          // a `response.create`, so a follow-up is guaranteed. Consume
          // the hold once and stay on `processing` so the orb keeps
          // showing "thinking" across the tool round-trip (e.g. the
          // `look` VLM call) instead of flashing back to idle. The
          // backstop timer covers the (rare) case where no follow-up
          // ever arrives.
          if (this.toolCallPendingResponse) {
            this.toolCallPendingResponse = false;
            break;
          }
          this.setStatus("connected");
        }
        break;

      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) {
          this.emit("transcript", { role: "user", text: delta, partial: true });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript =
          typeof payload.transcript === "string" ? payload.transcript : "";
        if (transcript) {
          this.emit("transcript", {
            role: "user",
            text: transcript,
            partial: false,
          });
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        this.markAudible();
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) {
          this.emit("transcript", {
            role: "assistant",
            text: delta,
            partial: true,
          });
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript =
          typeof payload.transcript === "string" ? payload.transcript : "";
        if (transcript) {
          this.emit("transcript", {
            role: "assistant",
            text: transcript,
            partial: false,
          });
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        const name = typeof payload.name === "string" ? payload.name : "";
        const argsRaw =
          typeof payload.arguments === "string" ? payload.arguments : "{}";
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsRaw);
        } catch {
          args = {};
        }
        if (callId && name) {
          // Hold the orb on "thinking" across the tool round-trip: the
          // tool-call `response.done` lands almost immediately, but the
          // actual work (and the follow-up spoken response) is still to
          // come. Without this the status bounces to idle mid-look.
          this.beginToolCallProcessingHold();
          this.emit("toolCall", { callId, name, arguments: args });
        }
        break;
      }

      case "error": {
        const err = payload.error as
          | { message?: string; code?: string; type?: string }
          | undefined;
        const code = err?.code ?? err?.type ?? "";
        if (
          code === "input_audio_buffer_commit_empty" ||
          code === "conversation_already_has_active_response"
        ) {
          if (code === "input_audio_buffer_commit_empty") {
            this.setStatus("connected");
          }
          return;
        }
        this.emit("error", {
          error: new Error(err?.message ?? "Hugging Face realtime error"),
        });
        this.setStatus("error");
        break;
      }
    }
  }

  private markConnectedAfterOutputDrain(): void {
    this.clearResponseDoneFallback();
    this.responseDoneFallbackTimer = window.setTimeout(() => {
      this.responseDoneFallbackTimer = null;
      if (this.status === "ai-speaking" || this.status === "processing") {
        console.warn(
          "[hf-realtime] output drain callback did not fire; leaving speaking state",
        );
        this.setStatus("connected");
      }
    }, RESPONSE_DONE_FALLBACK_MS);

    this.outputPlayer?.afterQueuedAudioDrains(() => {
      this.clearResponseDoneFallback();
      if (this.status === "ai-speaking" || this.status === "processing") {
        this.setStatus("connected");
      }
    });
  }

  private clearResponseDoneFallback(): void {
    if (this.responseDoneFallbackTimer !== null) {
      window.clearTimeout(this.responseDoneFallbackTimer);
      this.responseDoneFallbackTimer = null;
    }
  }
}

export function buildHfSessionConfig(options: {
  instructions: string;
  voice: string;
  tools: RealtimeTool[];
  transcriptionLanguage?: string;
}): Record<string, unknown> {
  return {
    type: "realtime",
    instructions: options.instructions,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: null },
        transcription: {
          model: "gpt-4o-transcribe",
          // Bias the transcriber toward the user-selected conversation
          // language instead of letting it auto-detect (which drifts on
          // short / accented utterances). Falls back to English.
          language: options.transcriptionLanguage ?? "en",
        },
        // Aligned with the on-robot conversation app's tuning. The
        // robot's mic and speaker sit a few cm apart in the same
        // shell, so residual speaker echo / room noise easily trips
        // a false barge-in (which cancels the in-flight response and
        // flips the orb back to listening mid-utterance). Raising the
        // activation threshold above the 0.5 default - plus explicit
        // padding / hangover - keeps real interruptions working while
        // ignoring the robot hearing itself. See
        // `reachy_mini_conversation_app/.../huggingface_realtime.py`.
        turn_detection: {
          type: "server_vad",
          interrupt_response: true,
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: null },
        voice: normalizeHfVoice(options.voice),
      },
    },
    tools: options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    tool_choice: "auto",
  };
}

export const HF_AVAILABLE_VOICES = [
  "Aiden",
  "Ryan",
  "Dylan",
  "Eric",
  "Ono_Anna",
  "Serena",
  "Sohee",
  "Uncle_Fu",
  "Vivian",
] as const;

export type HfVoiceId = (typeof HF_AVAILABLE_VOICES)[number];

export const HF_DEFAULT_VOICE: HfVoiceId = "Aiden";

export function normalizeHfVoice(value: string | null | undefined): HfVoiceId {
  const candidate = (value ?? "").trim().toLowerCase();
  const match = HF_AVAILABLE_VOICES.find(
    (voice) => voice.toLowerCase() === candidate,
  );
  return match ?? HF_DEFAULT_VOICE;
}

/**
 * POST the realtime session allocator, retrying transient 5xx (gateway
 * timeouts under load) a couple of times with a short backoff. A 4xx is a
 * real rejection and returned immediately - retrying it would only delay the
 * inevitable failure.
 */
async function postHfRealtimeSession(
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  // The init object contains only reusable string data, so every transient
  // retry sends the exact same attribution headers and JSON payload.
  const requestInit: RequestInit = {
    method: "POST",
    headers,
    body,
  };
  let response = await tauriFetch(HF_REALTIME_SESSION_PROXY_URL, requestInit);
  for (
    let attempt = 1;
    !response.ok && response.status >= 500 && attempt < ALLOCATOR_MAX_ATTEMPTS;
    attempt += 1
  ) {
    console.warn(
      `[hf-realtime] session allocator ${response.status}, retrying (${attempt}/${
        ALLOCATOR_MAX_ATTEMPTS - 1
      })...`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, ALLOCATOR_RETRY_BACKOFF_MS * attempt),
    );
    response = await tauriFetch(HF_REALTIME_SESSION_PROXY_URL, requestInit);
  }
  return response;
}

export async function resolveHfRealtimeWebSocketUrl(
  hfToken: string | null,
  hardwareId: string | null = null,
): Promise<string> {
  if (HF_REALTIME_CONNECTION_MODE === "local") {
    if (!HF_REALTIME_WS_URL) {
      throw new Error(
        "VITE_HF_REALTIME_WS_URL must be set when VITE_HF_REALTIME_CONNECTION_MODE=local",
      );
    }
    return normalizeHfRealtimeWebSocketUrl(HF_REALTIME_WS_URL);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": MOBILE_CLIENT_USER_AGENT,
  };
  if (hfToken) headers[REACHY_AUTHORIZATION_HEADER] = `Bearer ${hfToken}`;

  const normalizedHardwareId = hardwareId?.trim() ?? "";
  const body = JSON.stringify(
    normalizedHardwareId ? { hardware_id: normalizedHardwareId } : {},
  );

  const response = await postHfRealtimeSession(headers, body);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HF realtime session allocator failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | HfSessionAllocatorPayload
    | null;
  const connectUrl =
    typeof payload?.connect_url === "string" ? payload.connect_url : "";
  if (!connectUrl) {
    throw new Error(
      `HF realtime session allocator returned no connect_url: ${JSON.stringify(
        payload,
      )}`,
    );
  }

  const parsed = parseHfRealtimeUrl(connectUrl);
  if (!parsed.hasRealtimePath) {
    throw new Error(`Expected HF realtime connect URL ending with /realtime`);
  }

  console.info(
    `[hf-realtime] allocated session ${
      typeof payload?.session_id === "string" ? payload.session_id : "<unknown>"
    }`,
  );
  return parsed.websocketUrl;
}

export function normalizeHfRealtimeWebSocketUrl(realtimeUrl: string): string {
  return parseHfRealtimeUrl(realtimeUrl).websocketUrl;
}

export function parseHfRealtimeUrl(realtimeUrl: string): HfRealtimeUrlParts {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(realtimeUrl)
    ? realtimeUrl
    : `ws://${realtimeUrl}`;
  const parsed = new URL(withScheme);
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (!["ws", "wss", "http", "https"].includes(scheme)) {
    throw new Error(
      `Expected HF realtime URL to start with ws://, wss://, http://, or https://, got: ${realtimeUrl}`,
    );
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const hasRealtimePath = path.endsWith("/realtime");
  const basePath = hasRealtimePath ? path.slice(0, -"/realtime".length) : path;
  const realtimePath = hasRealtimePath ? path : `${path || ""}/realtime`;

  const connectQuery: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    if (key !== "model") connectQuery[key] = value;
  });

  const wsProtocol = scheme === "wss" || scheme === "https" ? "wss:" : "ws:";

  const websocketUrl = new URL(parsed.toString());
  websocketUrl.protocol = wsProtocol;
  websocketUrl.pathname = realtimePath;
  websocketUrl.search = "";
  for (const [key, value] of Object.entries(connectQuery)) {
    websocketUrl.searchParams.set(key, value);
  }

  const websocketBaseUrl = new URL(parsed.toString());
  websocketBaseUrl.protocol = wsProtocol;
  websocketBaseUrl.pathname = basePath || "/";
  websocketBaseUrl.search = "";
  websocketBaseUrl.hash = "";

  const defaultPort = 8765;
  const port = parsed.port ? Number(parsed.port) : defaultPort;

  return {
    websocketUrl: websocketUrl.toString(),
    websocketBaseUrl: websocketBaseUrl.toString().replace(/\/$/, ""),
    connectQuery,
    host: parsed.hostname || null,
    port,
    hasRealtimePath,
  };
}

class PcmInputStreamer {
  private readonly track: MediaStreamTrack;
  private readonly sendPcm: (pcm: Int16Array) => void;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;

  constructor(options: {
    track: MediaStreamTrack;
    sendPcm: (pcm: Int16Array) => void;
  }) {
    this.track = options.track;
    this.sendPcm = options.sendPcm;
  }

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([this.track]));
    const processor = ctx.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleFloat32(input, ctx.sampleRate, HF_SAMPLE_RATE);
      if (resampled.length === 0) return;
      this.sendPcm(floatToPcm16(resampled));
    };

    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => {
        console.warn("[hf-realtime] input AudioContext resume failed:", err);
      });
    }

    this.ctx = ctx;
    this.source = source;
    this.processor = processor;
    this.mute = mute;
  }

  stop(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.mute?.disconnect();
      this.ctx?.close();
    } catch {
      // ignored
    }
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.mute = null;
  }
}

class PcmOutputTrack {
  readonly track: MediaStreamTrack;

  private readonly sampleRate: number;
  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private nextStartTime = 0;
  private drainTimer: number | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.ctx = createAudioContext(sampleRate);
    this.destination = this.ctx.createMediaStreamDestination();
    const [track] = this.destination.stream.getAudioTracks();
    if (!track) throw new Error("Could not create HF output audio track");
    this.track = track;
  }

  appendBase64Pcm(base64: string): void {
    if (this.drainTimer !== null) {
      window.clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch((err) => {
        console.warn("[hf-realtime] output AudioContext resume failed:", err);
      });
    }

    const pcm = base64ToPcm16(base64);
    if (pcm.length === 0) return;

    const audioBuffer = this.ctx.createBuffer(1, pcm.length, this.sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));
    }

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.destination);

    const startAt = Math.max(
      this.nextStartTime,
      this.ctx.currentTime + OUTPUT_START_LEAD_S,
    );
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;
  }

  afterQueuedAudioDrains(cb: () => void): void {
    if (this.drainTimer !== null) {
      window.clearTimeout(this.drainTimer);
    }
    const delayMs = Math.max(
      0,
      (this.nextStartTime - this.ctx.currentTime) * 1000 + OUTPUT_DRAIN_PAD_MS,
    );
    this.drainTimer = window.setTimeout(() => {
      this.drainTimer = null;
      cb();
    }, delayMs);
  }

  close(): void {
    if (this.drainTimer !== null) {
      window.clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    try {
      this.track.stop();
      this.ctx.close();
    } catch {
      // ignored
    }
  }
}

function createAudioContext(sampleRate: number): AudioContext {
  try {
    return new AudioContext({ sampleRate });
  } catch {
    return new AudioContext();
  }
}

function resampleFloat32(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return new Float32Array(input);
  if (input.length === 0) return new Float32Array(0);

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(0, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return output;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return bytesToBase64(bytes);
}

function base64ToPcm16(base64: string): Int16Array {
  const bytes = base64ToBytes(base64);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
