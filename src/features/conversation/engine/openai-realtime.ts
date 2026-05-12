/**
 * Minimal OpenAI Realtime WebRTC client.
 *
 * We let the caller provide the input audio `MediaStreamTrack` (the robot's
 * microphone, received on a separate RTCPeerConnection) and expose the remote
 * track produced by OpenAI (synthesized voice) via the `outputTrack` event so
 * it can be routed to the robot's speakers with `sender.replaceTrack()`.
 *
 * References:
 *   https://platform.openai.com/docs/guides/realtime-webrtc
 *   https://platform.openai.com/docs/api-reference/realtime-client-events
 *   https://platform.openai.com/docs/api-reference/realtime-server-events
 */

// The original Space ported this engine used a same-origin proxy
// (`/openai/v1/realtime`) because OpenAI refuses cross-origin browser
// calls with a user API key in the Authorization header: nginx on the
// Space (and Vite in dev) forwarded the request to api.openai.com.
//
// Tauri WebViews don't live behind any such proxy. `fetch()` inside
// them is not subject to the browser's same-origin policy the same way
// - requests are issued by the native WebView and OpenAI's CORS check
// actually succeeds - so we can just hit the public endpoint directly.
//
// We target the GA WebRTC handshake (`POST /v1/realtime/calls`,
// FormData body with `sdp` + `session`). The legacy Beta endpoint
// (`POST /v1/realtime?model=...`, raw SDP body) is being deprecated
// on April 30, 2026 and is incompatible with reasoning-capable
// models such as `gpt-realtime-2`. Keep `VITE_OPENAI_REALTIME_URL`
// configurable for future setups (e.g. a corporate proxy) without
// forcing another fork.
const REALTIME_BASE_URL =
  (import.meta.env?.VITE_OPENAI_REALTIME_URL as string | undefined) ??
  "https://api.openai.com/v1/realtime/calls";

// ─── WiFi robustness knobs ──────────────────────────────────────────────
// Peak bitrate we allow Opus to use on our uplink. 32 kbps is plenty for
// clean voice; capping avoids saturating a weak WiFi AP which causes
// bursty packet loss.
const MAX_AUDIO_BITRATE_BPS = 32_000;
// Hint to the browser's jitter buffer: we'd rather play audio ~150 ms
// late than chop it up on jitter spikes. Voice assistants are forgiving
// of a bit of latency.
const PLAYOUT_DELAY_HINT_S = 0.15;
// Opus fmtp knobs forced via SDP munging. FEC inline gives us ~5-15%
// loss resilience "for free", DTX off keeps the comfort-noise packets
// arriving continuously so our own VAD/wobbler never thinks the line
// went silent.
const OPUS_FMTP_OVERRIDES: Record<string, string> = {
  minptime: "10",
  useinbandfec: "1",
  usedtx: "0",
  stereo: "0",
  "sprop-stereo": "0",
  maxaveragebitrate: String(MAX_AUDIO_BITRATE_BPS),
};
// How long we tolerate an ICE `disconnected` state before giving up.
// WiFi blips often self-heal within ~2 s; we budget a bit more than that.
const ICE_DISCONNECT_GRACE_MS = 5_000;

// ─── Whisper STT vocabulary hint ────────────────────────────────────────
// `whisper-1` accepts an `input_audio_transcription.prompt` field that
// behaves like the regular Whisper API `prompt` parameter: a short string
// of "previously transcribed context" used to bias the decoder toward the
// surface forms we want. We use it purely for proper nouns the model
// would otherwise mis-spell (heard as "richy mini", "polenrobotics", …).
//
// Why only these four:
//   - "Reachy" / "Reachy Mini" - product name, said often enough that a
//     bad transcript breaks our keyword-based vision trigger downstream.
//   - "Pollen Robotics" / "Hugging Face" - org names that show up in
//     intro chit-chat and on-boarding flows.
//
// The prompt explicitly stays language-agnostic: it MUST NOT carry any
// language hint (the user is in control of the conversation language
// via the system prompt; biasing Whisper would fight that flow). It is
// also intentionally short - Whisper takes only the trailing ~224
// tokens into account, so the shorter the prompt the more weight each
// term carries.
const WHISPER_VOCAB_PROMPT = "Reachy, Reachy Mini, Pollen Robotics, Hugging Face";

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "user-speaking"
  | "processing"
  | "ai-speaking"
  | "closed"
  | "error";

/**
 * OpenAI Realtime tool definition (a.k.a. function calling). We only expose
 * the subset of fields we actually populate; the API accepts more.
 */
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

export interface RealtimeOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  inputTrack: MediaStreamTrack;
  /** Optional list of tools exposed to the model. */
  tools?: RealtimeTool[];
}

type EventMap = {
  status: { status: RealtimeStatus };
  outputTrack: { track: MediaStreamTrack };
  transcript: { role: "user" | "assistant"; text: string; partial: boolean };
  toolCall: RealtimeToolCall;
  error: { error: unknown };
};

type Listener<K extends keyof EventMap> = (detail: EventMap[K]) => void;

export class OpenaiRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private listeners: { [K in keyof EventMap]?: Set<Listener<K>> } = {};
  private status: RealtimeStatus = "idle";
  // Debounces transient ICE disconnects so a brief WiFi blip doesn't
  // bubble up as an error all the way to the UI.
  private iceGraceTimer: number | null = null;
  // One-shot visibilitychange listener used when we disconnect while the
  // tab is hidden: we re-arm the grace timer only once the tab is active
  // so throttled timers can't cause spurious errors.
  private pendingVisibilityHandler: (() => void) | null = null;

  readonly options: RealtimeOptions;

  constructor(options: RealtimeOptions) {
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
        console.error("[openai-realtime] listener error:", err);
      }
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", { status });
  }

  /**
   * Bump the state to "ai-speaking" from any pre-speaking phase. Called
   * from whichever server event lands first to flag that Reachy has
   * started talking. Deliberately permissive (processing → ai-speaking
   * AND connected → ai-speaking) because depending on the transport we
   * might skip the intermediate processing phase entirely.
   */
  private markAudible(): void {
    if (this.status === "ai-speaking") return;
    if (this.status === "closed" || this.status === "error") return;
    this.setStatus("ai-speaking");
  }

  /**
   * Establish the WebRTC session with OpenAI. Resolves once the SDP exchange
   * completes; the data channel may still be opening asynchronously.
   */
  async connect(): Promise<void> {
    if (this.pc) throw new Error("Already connected");
    this.setStatus("connecting");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc = pc;

    pc.addTransceiver(this.options.inputTrack, {
      direction: "sendrecv",
      streams: [new MediaStream([this.options.inputTrack])],
    });

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      const track = event.track.kind === "audio" ? event.track : stream?.getAudioTracks()[0];
      if (track) {
        // Ask the browser to buffer a bit of playout. This costs latency
        // but trades it for resilience on jittery WiFi links.
        try {
          // `playoutDelayHint` is a non-standard but widely-shipped property.
          (event.receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint =
            PLAYOUT_DELAY_HINT_S;
        } catch {
          // Not fatal - older browsers just ignore the hint.
        }
        this.emit("outputTrack", { track });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        // We recovered before the grace timer fired - good.
        this.clearIceGrace();
        return;
      }
      if (s === "failed") {
        this.clearIceGrace();
        this.emit("error", { error: new Error("ICE failed") });
        this.setStatus("error");
        return;
      }
      if (s === "disconnected") {
        // Wait a bit - WebRTC flips to `disconnected` on WiFi blips and
        // self-heals once ICE finds packets again. Only escalate if it
        // stays that way past the grace window.
        //
        // Background tabs: browsers throttle JS timers heavily so a 5 s
        // setTimeout can fire minutes late, AND the native WebRTC stack
        // keeps running so the connection often recovers by then. We
        // pause the grace timer while the tab is hidden and wait for
        // visibilitychange before deciding anything.
        if (this.iceGraceTimer !== null) return;
        if (typeof document !== "undefined" && document.hidden) {
          console.warn(
            "[openai-realtime] ICE disconnected while tab hidden — deferring grace timer until visibility returns.",
          );
          this.armIceGraceOnVisibility();
          return;
        }
        this.scheduleIceGrace();
      }
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;

    // GA: session is configured at handshake (in the FormData `session`
    // field), not via a `session.update` event after the data channel
    // opens. We just flip status here; the DC stays open to receive
    // server events (transcripts, tool call args, response.done, ...)
    // and to optionally send `session.update` for runtime tweaks.
    dc.addEventListener("open", () => {
      this.setStatus("connected");
    });

    dc.addEventListener("message", (event) => this.handleEvent(event.data));
    dc.addEventListener("error", (event) => {
      console.error("[openai-realtime] data channel error:", event);
    });

    const rawOffer = await pc.createOffer();
    // Patch the offer SDP to force Opus FEC + a sane maxaveragebitrate.
    // This tells OpenAI how to decode our uplink AND advertises our
    // decoder's capabilities for the answer it sends back.
    const offerSdp = patchOpusFmtp(rawOffer.sdp ?? "");
    await pc.setLocalDescription({ type: "offer", sdp: offerSdp });

    // Enforce the bitrate cap on our sender too - many impls ignore the
    // SDP `maxaveragebitrate` without this.
    capSenderBitrate(pc, MAX_AUDIO_BITRATE_BPS).catch((err) => {
      console.warn("[openai-realtime] failed to cap sender bitrate:", err);
    });

    // GA handshake: multipart/form-data with `sdp` + `session` (JSON).
    // The `Content-Type` header is set automatically by FormData with
    // the right multipart boundary - do NOT override it here.
    const sessionConfig = this.buildSessionConfig();
    const form = new FormData();
    form.append("sdp", offerSdp);
    form.append("session", JSON.stringify(sessionConfig));

    const response = await fetch(REALTIME_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI Realtime handshake failed (${response.status}): ${text}`);
    }

    // GA still returns the SDP answer as plain text (not JSON). The
    // SIP `/accept` subresource returns JSON; the WebRTC entrypoint
    // doesn't.
    const rawAnswer = await response.text();
    // Patch the answer too so our *decoder* honours the same FEC knobs.
    const answerSdp = patchOpusFmtp(rawAnswer);
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  /**
   * Build the GA-shaped session config payload for the handshake's
   * `session` FormData field. Notable shape changes vs the Beta
   * `session.update` event:
   *
   *   - `model` lives **inside** the session object now (was a query
   *     param `?model=...` on the Beta endpoint).
   *   - `voice` moved from `session.voice` to
   *     `session.audio.output.voice`.
   *   - `input_audio_format` / `output_audio_format` (string `"pcm16"`)
   *     moved to `session.audio.{input,output}.format` (object with
   *     `type` + `rate`). 24 kHz `audio/pcm` is the only PCM rate
   *     supported in GA.
   *   - `input_audio_transcription` → `session.audio.input.transcription`.
   *   - `turn_detection` → `session.audio.input.turn_detection`.
   *   - `modalities: ["audio", "text"]` → `output_modalities: ["audio"]`
   *     (audio responses always include a transcript; the legacy "text"
   *     entry is no longer accepted alongside audio).
   *   - `temperature` is removed entirely.
   *   - `reasoning.effort` is now meaningful (only the
   *     reasoning-capable snapshots like `gpt-realtime-2` honour it;
   *     the others ignore it silently).
   *   - `tools` / `tool_choice` stay at the top level of the session.
   */
  private buildSessionConfig(): Record<string, unknown> {
    const tools = (this.options.tools ?? []).map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const session: Record<string, unknown> = {
      type: "realtime",
      model: this.options.model,
      output_modalities: ["audio"],
      instructions: this.options.instructions,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: {
            model: "whisper-1",
            // Vocabulary nudge, NOT a language hint. See
            // WHISPER_VOCAB_PROMPT comment above.
            prompt: WHISPER_VOCAB_PROMPT,
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: this.options.voice,
        },
      },
      // Reasoning effort knob, only meaningful for the reasoning-
      // capable Realtime models (`gpt-realtime-2`, future snapshots).
      // Older snapshots (`gpt-realtime`) silently ignore it. `low` is
      // OpenAI's recommended setting for production voice agents -
      // it keeps the time-to-first-audio comparable to non-reasoning
      // models, while still letting the model think briefly when a
      // complex instruction lands. Bump to `medium` / `high` only
      // if a specific workflow needs deeper reasoning AND can
      // tolerate a perceptible response-start delay.
      reasoning: { effort: "low" },
    };
    if (tools.length) {
      session.tools = tools;
      session.tool_choice = "auto";
    }
    return session;
  }

  private clearIceGrace(): void {
    if (this.iceGraceTimer !== null) {
      clearTimeout(this.iceGraceTimer);
      this.iceGraceTimer = null;
    }
    if (this.pendingVisibilityHandler) {
      document.removeEventListener("visibilitychange", this.pendingVisibilityHandler);
      this.pendingVisibilityHandler = null;
    }
  }

  /**
   * Arm the ICE grace timer proper. Safe to call once we know the tab
   * is in the foreground (timers aren't throttled).
   */
  private scheduleIceGrace(): void {
    if (this.iceGraceTimer !== null) return;
    console.warn(
      `[openai-realtime] ICE disconnected, waiting ${ICE_DISCONNECT_GRACE_MS}ms before giving up`,
    );
    this.iceGraceTimer = window.setTimeout(() => {
      this.iceGraceTimer = null;
      if (!this.pc) return;
      const still = this.pc.iceConnectionState;
      if (still === "disconnected" || still === "failed") {
        this.emit("error", {
          error: new Error(`ICE stuck in '${still}' for > ${ICE_DISCONNECT_GRACE_MS}ms`),
        });
        this.setStatus("error");
      }
    }, ICE_DISCONNECT_GRACE_MS);
  }

  /**
   * We're disconnected AND the tab is hidden. Wait for visibility to
   * return before deciding: the connection often self-heals while we're
   * in the background, and JS timers there fire unpredictably late.
   */
  private armIceGraceOnVisibility(): void {
    if (this.pendingVisibilityHandler) return;
    const handler = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", handler);
      this.pendingVisibilityHandler = null;
      if (!this.pc) return;
      const s = this.pc.iceConnectionState;
      if (s === "connected" || s === "completed") return; // healed itself
      if (s === "failed") {
        this.emit("error", { error: new Error("ICE failed") });
        this.setStatus("error");
        return;
      }
      // Still disconnected when we came back - now give it the normal
      // grace window with a foreground timer that'll actually fire.
      this.scheduleIceGrace();
    };
    document.addEventListener("visibilitychange", handler);
    this.pendingVisibilityHandler = handler;
  }

  private handleEvent(raw: string): void {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    // Lightweight trace of every server event. Makes it trivial to see
    // in DevTools whether the state-triggering events (speech_started,
    // output_audio.delta, audio_transcript.delta, response.done, ...)
    // actually reach the data channel for the current transport.
    if (typeof event.type === "string") {
      console.debug("[openai-realtime] event:", event.type);
    }

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.setStatus("user-speaking");
        break;

      case "input_audio_buffer.speech_stopped":
        // User stopped talking; the model is computing its reply and will
        // start audio shortly. We surface this as `processing` so the UI
        // can show a "thinking" visual until audio actually arrives.
        if (this.status === "user-speaking") {
          this.setStatus("processing");
        }
        break;

      // ─── "Assistant is speaking" triggers ─────────────────────────
      //
      // Multiple events can mark the start of an audible reply, and
      // which ones actually fire depends on the transport:
      //
      //   - WebSocket: the audio itself streams as `response.output_audio.delta`
      //     events on the same channel.
      //   - WebRTC: the audio goes through the media track, not the
      //     data channel, so `output_audio.delta` frames may be sparse
      //     or missing entirely. But `output_audio_transcript.delta`
      //     and `content_part.added` with an output_audio part DO
      //     fire reliably over the data channel, so we listen to all
      //     of them and whichever lands first flips us to ai-speaking.
      //
      // Transcript deltas are handled in their own case below (they
      // also need to emit a `transcript` event), so we duplicate the
      // `markAudible()` call there rather than listing them here.
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.markAudible();
        break;

      case "response.content_part.added": {
        const part = event.part as { type?: string } | undefined;
        if (part?.type === "audio" || part?.type === "output_audio") {
          this.markAudible();
        }
        break;
      }

      case "response.created":
      case "response.output_item.added":
        // No audio yet, just metadata; keep us in `processing` until
        // we get a clearer "speaking" signal above.
        if (this.status === "connected" || this.status === "user-speaking") {
          this.setStatus("processing");
        }
        break;

      case "response.done":
      case "response.cancelled":
        if (this.status === "ai-speaking" || this.status === "processing") {
          this.setStatus("connected");
        }
        break;

      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          this.emit("transcript", { role: "user", text: delta, partial: true });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = typeof event.transcript === "string" ? event.transcript : "";
        if (transcript) {
          this.emit("transcript", { role: "user", text: transcript, partial: false });
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        // Transcript deltas fire continuously while the model streams
        // audio. Over WebRTC they're our most reliable "Reachy is
        // actually talking right now" signal because `output_audio.delta`
        // metadata events don't always reach the data channel.
        this.markAudible();
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          this.emit("transcript", { role: "assistant", text: delta, partial: true });
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = typeof event.transcript === "string" ? event.transcript : "";
        if (transcript) {
          this.emit("transcript", { role: "assistant", text: transcript, partial: false });
        }
        break;
      }

      case "response.function_call_arguments.done": {
        // The model finished streaming tool arguments; execute & reply.
        const callId = typeof event.call_id === "string" ? event.call_id : "";
        const name = typeof event.name === "string" ? event.name : "";
        const argsRaw = typeof event.arguments === "string" ? event.arguments : "{}";
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsRaw);
        } catch {
          args = {};
        }
        if (callId && name) {
          this.emit("toolCall", { callId, name, arguments: args });
        }
        break;
      }

      case "error": {
        const err = event.error as { message?: string } | undefined;
        this.emit("error", { error: new Error(err?.message ?? "OpenAI error") });
        break;
      }
    }
  }

  /**
   * Send a raw client event to the OpenAI Realtime data channel. Made
   * `public` so side-channel modules (vision, future memory/telemetry)
   * can push `conversation.item.create` and similar events without
   * having to extend this class. No-op when the data channel hasn't
   * opened yet or has already closed (covers the transparent reconnect
   * window where the bridge has no live client).
   */
  sendEvent(event: Record<string, unknown>): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    this.dc.send(JSON.stringify(event));
  }

  /**
   * Send the result of a previously received `toolCall` back to the model
   * so it can continue the conversation. `output` will be JSON-stringified
   * if it isn't a string already.
   */
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
    // Ask the model to pick up from here and speak the reply.
    this.sendEvent({ type: "response.create" });
  }

  async close(): Promise<void> {
    this.clearIceGrace();

    try {
      this.dc?.close();
    } catch {
      // ignored
    }
    this.dc = null;

    try {
      this.pc?.close();
    } catch {
      // ignored
    }
    this.pc = null;

    this.setStatus("closed");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Rewrite all `a=fmtp:<pt> ...` lines for Opus payload types so that they
 * include our required parameters (FEC on, DTX off, bitrate cap). Missing
 * fmtp lines are synthesized next to the matching `a=rtpmap` line.
 */
function patchOpusFmtp(sdp: string): string {
  if (!sdp) return sdp;

  // Find every Opus payload type via its rtpmap entry.
  const rtpmapRe = /^a=rtpmap:(\d+)\s+opus\/48000/gim;
  const payloadTypes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rtpmapRe.exec(sdp)) !== null) {
    payloadTypes.push(m[1]);
  }
  if (payloadTypes.length === 0) return sdp;

  let patched = sdp;
  for (const pt of payloadTypes) {
    const fmtpLineRe = new RegExp(`^a=fmtp:${pt}\\s+([^\\r\\n]*)`, "m");
    const existing = fmtpLineRe.exec(patched);
    if (existing) {
      const merged = mergeFmtpParams(existing[1], OPUS_FMTP_OVERRIDES);
      patched = patched.replace(fmtpLineRe, `a=fmtp:${pt} ${merged}`);
    } else {
      const merged = mergeFmtpParams("", OPUS_FMTP_OVERRIDES);
      // Insert the new fmtp line right after the matching rtpmap.
      const rtpmapLineRe = new RegExp(`(^a=rtpmap:${pt}\\s+opus/48000[^\\r\\n]*)`, "m");
      patched = patched.replace(rtpmapLineRe, `$1\r\na=fmtp:${pt} ${merged}`);
    }
  }
  return patched;
}

function mergeFmtpParams(existing: string, overrides: Record<string, string>): string {
  const params = new Map<string, string>();
  for (const chunk of existing.split(";")) {
    const kv = chunk.trim();
    if (!kv) continue;
    const eq = kv.indexOf("=");
    if (eq < 0) params.set(kv, "");
    else params.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  for (const [k, v] of Object.entries(overrides)) {
    params.set(k, v);
  }
  return Array.from(params.entries())
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join(";");
}

/**
 * Cap the outbound audio sender's bitrate. The spec recommends setting
 * `maxBitrate` on the first (and typically only) encoding.
 */
async function capSenderBitrate(pc: RTCPeerConnection, maxBitrate: number): Promise<void> {
  const sender = pc
    .getSenders()
    .find((s) => s.track && s.track.kind === "audio");
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  for (const enc of params.encodings) {
    enc.maxBitrate = maxBitrate;
  }
  await sender.setParameters(params);
}
