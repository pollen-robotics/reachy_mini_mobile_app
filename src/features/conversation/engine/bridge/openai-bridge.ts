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
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type {
  RealtimeBackend,
  RealtimeBackendDeps,
  RealtimePort,
  RealtimeStatusKind,
  RealtimeToolCallEvent,
} from "../realtime/types";

/**
 * OpenAI-specific deps: the shared contract plus the async ephemeral-key
 * getter and the realtime model id (the provider auth + config the
 * factory injects). Everything else (`voice`, `composeInstructions`,
 * the `on*` callbacks, …) comes from `RealtimeBackendDeps`.
 */
export interface OpenaiBridgeDeps extends RealtimeBackendDeps {
  /**
   * Async getter for an OpenAI Realtime ephemeral key. Forwarded
   * verbatim to `OpenaiRealtimeClient.RealtimeOptions.getApiKey`,
   * which calls it once per SDP handshake (wired to `mintEphemeralKey`).
   * A function (not a string) so a reconnect crossing the ~10 min key
   * lifetime mints a fresh key without rebuilding the bridge.
   */
  getApiKey: () => Promise<string>;
  /** OpenAI Realtime model id (e.g. `gpt-realtime-2`). */
  model: string;
}

const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 1;

export function createOpenaiBridge(deps: OpenaiBridgeDeps): RealtimeBackend {
  let client: OpenaiRealtimeClient | null = null;
  let openaiSink: HTMLAudioElement | null = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  // Last mic track we connected with. Cached so the silent retry
  // path can rebuild a session against the same input without the
  // engine having to re-fetch it from the SDK.
  let lastMicTrack: MediaStreamTrack | null = null;
  // Mic-mute state. The robot's mic track is what we send to OpenAI,
  // so muting = disabling that track (OpenAI receives silence, the
  // assistant stops hearing the user). The SDK's `setMicMuted` can't
  // do this anymore — since SDK 1.8.0 the SDK no longer owns a
  // getUserMedia stream, so its `setMicMuted` is a no-op. The bridge
  // owns the robot-mic track (it routes it to the OpenAI client), so
  // the gate lives here. Kept as state (not just a one-shot toggle)
  // so a transparent reconnect re-applies it to the fresh track.
  let micMuted = false;

  // ─── RealtimePort (side-channel) bookkeeping ──────────────────────
  // Subscribers register once at boot. Each fresh client built below
  // re-attaches its own `transcript` listener that fans out to this
  // set, so a transparent reconnect doesn't drop side-channel
  // observers (vision, future memory, etc.).
  const userTranscriptSubs = new Set<(text: string) => void>();

  const buildClient = (
    robotMicTrack: MediaStreamTrack,
  ): OpenaiRealtimeClient => {
    // Resolve tools lazily here (not once at bridge construction) so a
    // getter form is re-evaluated on every connect/reconnect - lets the
    // host narrow the set between sessions (e.g. drop memory tools).
    const tools =
      typeof deps.tools === 'function'
        ? deps.tools()
        : deps.tools ?? ROBOT_TOOLS;
    const next = new OpenaiRealtimeClient({
      getApiKey: deps.getApiKey,
      model: deps.model,
      voice: typeof deps.voice === 'function' ? deps.voice() : deps.voice,
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

    next.on("toolCall", (call: RealtimeToolCallEvent) => {
      try {
        deps.onToolCall(call);
      } catch (err) {
        console.warn("[openai-bridge] onToolCall threw:", err);
      }
    });

    next.on("error", ({ error }) => {
      console.error("[openai]", error);
    });

    // Side-channel: fan completed user transcripts out to anyone
    // subscribed via the `RealtimePort`. We deliberately ignore
    // partial deltas (false-positive risk on STT keyword matchers)
    // and only forward final transcripts.
    next.on("transcript", ({ role, text, partial }) => {
      if (role !== "user" || partial) return;
      if (!text) return;
      for (const sub of userTranscriptSubs) {
        try {
          sub(text);
        } catch (err) {
          console.warn("[openai-bridge] user transcript subscriber threw:", err);
        }
      }
    });

    return next;
  };

  const connect = async (robotMicTrack: MediaStreamTrack): Promise<void> => {
    lastMicTrack = robotMicTrack;
    // Re-apply the current mute state to the freshly-bound track so a
    // transparent reconnect (or a mid-session mute set before the
    // first connect) survives the new MediaStreamTrack instance.
    robotMicTrack.enabled = !micMuted;
    const next = buildClient(robotMicTrack);
    client = next;
    await next.connect();
  };

  const setMicMuted = (muted: boolean): void => {
    micMuted = muted;
    if (lastMicTrack) lastMicTrack.enabled = !muted;
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

    const transceivers = pc.getTransceivers();
    const audioTransceiver = transceivers.find(
      (t) =>
        t.receiver.track?.kind === "audio" ||
        t.sender.track?.kind === "audio",
    );
    console.log(
      "[openai-bridge] route:",
      "transceivers=",
      transceivers.map(
        (t) =>
          `dir=${t.direction}/curr=${t.currentDirection}/recv=${t.receiver.track?.kind ?? "-"}/send=${t.sender.track?.kind ?? "-"}`,
      ),
      "audioMuted=",
      robot.audioMuted,
    );
    const audioSender = audioTransceiver?.sender ?? null;
    if (audioSender) {
      // If the negotiated direction stranded our side at recvonly
      // (which happens when the SDK couldn't open the phone mic and
      // therefore answered with no local track), bump it back to
      // sendrecv so the freshly-replaced track has an actual
      // transmit path. Direction changes after negotiation trigger
      // a `negotiationneeded` event - the SDK will emit a fresh
      // offer/answer over its data channel.
      if (
        audioTransceiver &&
        audioTransceiver.direction !== "sendrecv" &&
        audioTransceiver.direction !== "sendonly"
      ) {
        try {
          audioTransceiver.direction = "sendrecv";
          console.log(
            "[openai-bridge] flipped transceiver direction to sendrecv",
          );
        } catch (err) {
          console.warn(
            "[openai-bridge] could not bump transceiver direction:",
            err,
          );
        }
      }
      audioSender
        .replaceTrack(track)
        .then(() => {
          console.log(
            "[openai-bridge] replaceTrack OK; sender.track=",
            audioSender.track?.id,
            "transceiver.direction=",
            audioTransceiver?.direction,
            "currentDirection=",
            audioTransceiver?.currentDirection,
          );
        })
        .catch((err) => {
          console.error("[openai-bridge] replaceTrack failed", err);
        });
    } else {
      console.warn(
        "[openai-bridge] no audio transceiver on the robot peer — " +
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

  // Single port instance shared by all side-channel modules. The
  // closures resolve `client` and `userTranscriptSubs` lazily so the
  // port stays valid across reconnects (a fresh client takes over;
  // subscriptions persist).
  const realtimePort: RealtimePort = {
    sendEvent: (event) => {
      if (!client) return;
      try {
        client.sendEvent(event);
      } catch (err) {
        console.warn("[openai-bridge] sendEvent via RealtimePort failed:", err);
      }
    },
    onUserTranscript: (cb) => {
      userTranscriptSubs.add(cb);
      return () => userTranscriptSubs.delete(cb);
    },
  };

  const getRealtimePort = (): RealtimePort => realtimePort;

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
    setMicMuted,
    getRealtimePort,
  };
}

/**
 * Type-guard mapping the SDK's full `RealtimeStatus` union onto the
 * bridge's narrower `OpenaiStatusKind`. Centralised here so future
 * status additions on the SDK side stay an explicit decision (allow
 * vs forward vs swallow) rather than a silent change in behaviour.
 */
function isForwardableStatus(status: RealtimeStatus): status is RealtimeStatusKind {
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
