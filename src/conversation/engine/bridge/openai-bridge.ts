/**
 * OpenAI Realtime ⇄ Reachy bridge.
 *
 * Owns everything that lives between the robot and the OpenAI
 * Realtime API:
 *
 *   - Construction & lifecycle of the `OpenaiRealtimeClient`
 *     (apiKey / model / voice / instructions / tools).
 *   - Routing of the AI output track onto the robot's audio sender
 *     so the robot's speaker plays the synthesised voice.
 *   - The hidden `<audio>` sink that some browsers require to actually
 *     pump data through an inbound WebRTC track (decoded but not
 *     output anywhere visible).
 *   - One-shot transparent reconnect on transient errors. The bridge
 *     limits itself to a single retry, then surrenders to the engine
 *     via `onFatalError` so the host can show "Tap to reconnect".
 *   - Mic-track lookup helper (the SDK doesn't expose the robot's
 *     on-board mic directly, so we dig into the `RTCPeerConnection`).
 *
 * Outwards events
 * ───────────────
 * The bridge does NOT touch the engine state machine, motion
 * controllers or audio analysers - those are engine concerns. The
 * bridge instead surfaces the OpenAI-side observations through a
 * small set of callbacks (`onStatus`, `onOutputTrack`, `onToolCall`,
 * `onReconnecting`, `onFatalError`) that the engine wires to its
 * own state transitions.
 */

import { OpenaiRealtimeClient, type RealtimeStatus } from "../openai-realtime";
import { ROBOT_TOOLS } from "../tools";
import type { ReachyMiniInstance } from "../globals";

/**
 * Subset of `RealtimeStatus` the engine cares about. The bridge
 * filters out the lifecycle states (`idle`, `closed`, `error`) and
 * forwards only the conversation-relevant transitions.
 */
export type OpenaiStatusKind =
  | "connected"
  | "user-speaking"
  | "processing"
  | "ai-speaking";

export interface OpenaiToolCallEvent {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenaiBridgeDeps {
  /** Live SDK accessor. The bridge needs the robot's
   *  `RTCPeerConnection` to plug the AI output track into the
   *  robot's audio sender. Returns null while we're pre-connect. */
  getRobot: () => ReachyMiniInstance | null;

  // ─── Construction settings ──────────────────────────────────────────
  apiKey: string;
  model: string;
  voice: string;
  /**
   * Compose the system prompt at connect time. We resolve it lazily
   * (rather than passing a static string) so the engine can fold a
   * fresh memory-store digest into the instructions on every
   * reconnect, without the bridge having to know about memory.
   */
  composeInstructions: () => string;
  /** Tool descriptors handed to the model. The default is the
   *  engine's curated `ROBOT_TOOLS` set, but kept overridable so a
   *  test or a future variant can pass a narrower list. */
  tools?: typeof ROBOT_TOOLS;

  // ─── Outwards events (forwarded to the engine) ──────────────────────
  /** Forwarded `OpenaiRealtimeClient.on("status")`. */
  onStatus: (status: OpenaiStatusKind) => void;
  /** Forwarded `OpenaiRealtimeClient.on("outputTrack")`. The bridge
   *  has already routed the track to the robot's speaker by the time
   *  this fires, so the engine just needs to wire its motion +
   *  level-monitor side effects. */
  onOutputTrack: (track: MediaStreamTrack) => void;
  /** Forwarded `OpenaiRealtimeClient.on("toolCall")`. The engine
   *  feeds it to its tool-call handler, which sends a response back
   *  through the bridge's `sendToolResponse()`. */
  onToolCall: (call: OpenaiToolCallEvent) => void;
  /** Fired when the bridge starts a transparent reconnect attempt.
   *  The engine reacts by pausing motion agents (their input track
   *  is about to go away) and dropping the orb to a transient
   *  "starting" visual. */
  onReconnecting: () => void;
  /** Fired when the bridge has exhausted its one-shot retry budget.
   *  The engine reacts by flipping the FSM to `error` and surfacing
   *  a user-facing message. */
  onFatalError: (err: Error) => void;
}

export interface OpenaiBridge {
  /** Open a fresh OpenAI session bound to `robotMicTrack`. Returns
   *  once the SDP handshake has resolved. */
  connect: (robotMicTrack: MediaStreamTrack) => Promise<void>;
  /** Tear down the OpenAI peer + audio sink. Safe to call
   *  repeatedly; idempotent. Does NOT clear the reconnect-attempts
   *  counter (use `resetReconnectCounter()` for that). */
  close: () => Promise<void>;
  /** Send a tool response to the active client. Returns false if
   *  there's no live client (e.g. the engine raced a teardown). */
  sendToolResponse: (
    callId: string,
    result: { ok: boolean; message: string },
  ) => boolean;
  /** Whether a transparent reconnect is currently in flight. The
   *  engine reads this to gate UI transitions (e.g. don't surface a
   *  fresh `error` while we're already retrying). */
  isReconnecting: () => boolean;
  /** Reset the per-session reconnect counter. The engine calls this
   *  on every fresh `doStart()` so a previous flaky session doesn't
   *  poison the new one. */
  resetReconnectCounter: () => void;
  /** Resolve the robot's microphone track from its peer connection.
   *  Pure helper kept here because mic ↔ AI plumbing is part of the
   *  bridge's responsibility. */
  getRobotMicTrack: (robotInstance: ReachyMiniInstance) => MediaStreamTrack | null;
}

const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 1;

export function createOpenaiBridge(deps: OpenaiBridgeDeps): OpenaiBridge {
  let client: OpenaiRealtimeClient | null = null;
  let openaiSink: HTMLAudioElement | null = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  // Last mic track we connected with. Cached so the silent retry
  // path can rebuild a session against the same input without the
  // engine having to re-fetch it from the SDK.
  let lastMicTrack: MediaStreamTrack | null = null;

  const tools = deps.tools ?? ROBOT_TOOLS;

  const buildClient = (
    robotMicTrack: MediaStreamTrack,
  ): OpenaiRealtimeClient => {
    const next = new OpenaiRealtimeClient({
      apiKey: deps.apiKey,
      model: deps.model,
      voice: deps.voice,
      instructions: deps.composeInstructions(),
      inputTrack: robotMicTrack,
      tools,
    });

    next.on("outputTrack", ({ track }) => {
      // Route the AI voice to the robot's speaker FIRST, then forward
      // to the engine. The engine wires the wobbler + AI level
      // monitor on receipt; if it ran first and the routing failed,
      // we'd have visuals reacting to a track that never makes it
      // out of the speaker.
      routeOutputToRobot(track);
      try {
        deps.onOutputTrack(track);
      } catch (err) {
        console.warn("[openai-bridge] onOutputTrack threw:", err);
      }
    });

    next.on("status", ({ status }) => {
      // `connected` always resets the retry budget: we made it
      // through a full handshake, so the next transient hiccup
      // gets a fresh retry.
      if (status === "connected") reconnectAttempts = 0;

      // Fatal-side lifecycle: trigger a one-shot silent reconnect.
      // `closed` and `idle` are ignored - they're internal SDK
      // bookkeeping that the engine doesn't model.
      if (status === "error") {
        // Don't re-enter retry while a previous attempt is still
        // running - the bridge is single-flight by design.
        if (reconnecting) return;
        if (lastMicTrack) {
          void tryReconnect(
            lastMicTrack,
            new Error("OpenAI connection lost"),
          );
        } else {
          deps.onFatalError(new Error("OpenAI connection lost"));
        }
        return;
      }

      // Forward only the conversation-relevant statuses; the engine
      // doesn't have UI states for `idle`/`closed` (it parks itself
      // through the explicit teardown flow instead).
      if (!isForwardableStatus(status)) return;

      try {
        deps.onStatus(status);
      } catch (err) {
        console.warn("[openai-bridge] onStatus threw:", err);
      }
    });

    next.on("toolCall", (call: OpenaiToolCallEvent) => {
      try {
        deps.onToolCall(call);
      } catch (err) {
        console.warn("[openai-bridge] onToolCall threw:", err);
      }
    });

    next.on("error", ({ error }) => {
      console.error("[openai]", error);
    });

    return next;
  };

  const connect = async (robotMicTrack: MediaStreamTrack): Promise<void> => {
    lastMicTrack = robotMicTrack;
    const next = buildClient(robotMicTrack);
    client = next;
    await next.connect();
  };

  const tryReconnect = async (
    robotMicTrack: MediaStreamTrack,
    cause: Error,
  ): Promise<void> => {
    if (reconnecting) return;
    if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      deps.onFatalError(cause);
      return;
    }

    reconnecting = true;
    reconnectAttempts += 1;
    console.warn(
      "[openai-bridge] connection lost, attempting silent reconnect…",
      cause,
    );
    try {
      deps.onReconnecting();
    } catch (err) {
      console.warn("[openai-bridge] onReconnecting threw:", err);
    }

    try {
      await client?.close();
    } catch (err) {
      console.warn("[openai-bridge] close during reconnect failed:", err);
    }
    client = null;

    // Let the network settle - otherwise the new ICE gathering often
    // lands on the same broken path.
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));

    try {
      await connect(robotMicTrack);
    } catch (err) {
      reconnecting = false;
      deps.onFatalError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    reconnecting = false;
  };

  const close = async (): Promise<void> => {
    try {
      await client?.close();
    } catch (err) {
      console.warn("[openai-bridge] close failed:", err);
    }
    client = null;
    teardownSink();
  };

  const sendToolResponse = (
    callId: string,
    result: { ok: boolean; message: string },
  ): boolean => {
    if (!client) return false;
    try {
      client.sendToolResponse(callId, result);
      return true;
    } catch (err) {
      console.warn("[openai-bridge] sendToolResponse failed:", err);
      return false;
    }
  };

  const isReconnecting = (): boolean => reconnecting;

  const resetReconnectCounter = (): void => {
    reconnectAttempts = 0;
  };

  /**
   * Pipe the OpenAI-generated audio track to the robot's audio sender
   * (so the robot's speakers play the synthesised voice).
   *
   * We also keep a hidden `<audio>` element hooked to the track,
   * because some browsers don't pump data through an inbound track
   * until it has a local consumer.
   */
  const routeOutputToRobot = (track: MediaStreamTrack): void => {
    const robot = deps.getRobot();
    if (!robot) return;
    const pc = robot._pc;
    if (!pc) return;

    const audioSender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (audioSender) {
      audioSender.replaceTrack(track).catch((err) => {
        console.error("[openai-bridge] replaceTrack failed", err);
      });
    } else {
      console.warn(
        "[openai-bridge] no audio sender on the robot peer — " +
          "the robot may not support bidirectional audio",
      );
    }

    if (!openaiSink) {
      openaiSink = document.createElement("audio");
      openaiSink.autoplay = true;
      openaiSink.muted = true;
      document.body.appendChild(openaiSink);
    }
    openaiSink.srcObject = new MediaStream([track]);
  };

  const teardownSink = (): void => {
    if (!openaiSink) return;
    openaiSink.srcObject = null;
    openaiSink.remove();
    openaiSink = null;
  };

  const getRobotMicTrack = (
    robotInstance: ReachyMiniInstance,
  ): MediaStreamTrack | null => {
    const pc = robotInstance._pc;
    if (!pc) return null;
    for (const receiver of pc.getReceivers()) {
      if (receiver.track && receiver.track.kind === "audio") {
        return receiver.track;
      }
    }
    return null;
  };

  return {
    connect,
    close,
    sendToolResponse,
    isReconnecting,
    resetReconnectCounter,
    getRobotMicTrack,
  };
}

/**
 * Type-guard mapping the SDK's full `RealtimeStatus` union onto the
 * bridge's narrower `OpenaiStatusKind`. Centralised here so future
 * status additions on the SDK side stay an explicit decision (allow
 * vs forward vs swallow) rather than a silent change in behaviour.
 */
function isForwardableStatus(status: RealtimeStatus): status is OpenaiStatusKind {
  switch (status) {
    case "connected":
    case "user-speaking":
    case "processing":
    case "ai-speaking":
      return true;
    case "idle":
    case "connecting":
    case "closed":
    case "error":
      return false;
  }
}
