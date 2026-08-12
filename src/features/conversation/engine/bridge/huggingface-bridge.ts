/**
 * Hugging Face realtime ⇄ Reachy bridge.
 *
 * Owns the transport between the robot and the HF realtime backend:
 * client construction, PCM websocket lifecycle, assistant audio routing
 * to the robot speaker, transcript/tool fan-out, and one-shot reconnect.
 */

import {
  HuggingFaceRealtimeClient,
  type RealtimeStatus,
} from "../huggingface-realtime";
import { ROBOT_TOOLS } from "../tools";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";
import type {
  RealtimeBackend,
  RealtimeBackendDeps,
  RealtimePort,
  RealtimeStatusKind,
  RealtimeToolCallEvent,
} from "../realtime/types";

/** HF-specific deps: the shared contract plus the user's HF token getter
 *  (the provider auth the backend controller injects). */
export interface HuggingFaceBridgeDeps extends RealtimeBackendDeps {
  getHfToken: () => string | null;
}

const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 1;

export function createHuggingFaceBridge(
  deps: HuggingFaceBridgeDeps,
): RealtimeBackend {
  let client: HuggingFaceRealtimeClient | null = null;
  let audioSink: HTMLAudioElement | null = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let connecting = false;
  let lastMicTrack: MediaStreamTrack | null = null;
  // Latest AI output track. Kept so `rebindRobotAudio` can re-route it
  // onto the sender of a freshly re-dialled peer connection.
  let lastOutputTrack: MediaStreamTrack | null = null;
  let micMuted = false;

  const userTranscriptSubs = new Set<(text: string) => void>();

  const buildClient = (
    robotMicTrack: MediaStreamTrack,
  ): HuggingFaceRealtimeClient => {
    const tools =
      typeof deps.tools === "function"
        ? deps.tools()
        : (deps.tools ?? ROBOT_TOOLS);
    const next = new HuggingFaceRealtimeClient({
      getHfToken: deps.getHfToken,
      hardwareId: deps.getRobotHardwareId(),
      voice: typeof deps.voice === "function" ? deps.voice() : deps.voice,
      transcriptionLanguage:
        typeof deps.transcriptionLanguage === "function"
          ? deps.transcriptionLanguage()
          : deps.transcriptionLanguage,
      instructions: deps.composeInstructions(),
      inputTrack: robotMicTrack,
      tools,
    });

    next.on("outputTrack", ({ track }) => {
      lastOutputTrack = track;
      routeOutputToRobot(track);
      try {
        deps.onOutputTrack(track);
      } catch (err) {
        console.warn("[hf-bridge] onOutputTrack threw:", err);
      }
    });

    next.on("status", ({ status }) => {
      if (status === "connected") reconnectAttempts = 0;

      if (status === "error") {
        if (connecting) return;
        if (reconnecting) return;
        if (lastMicTrack) {
          void tryReconnect(
            lastMicTrack,
            new Error("Hugging Face realtime connection lost"),
          );
        } else {
          deps.onFatalError(new Error("Hugging Face realtime connection lost"));
        }
        return;
      }

      if (!isForwardableStatus(status)) return;

      try {
        deps.onStatus(status);
      } catch (err) {
        console.warn("[hf-bridge] onStatus threw:", err);
      }
    });

    next.on("toolCall", (call: RealtimeToolCallEvent) => {
      try {
        deps.onToolCall(call);
      } catch (err) {
        console.warn("[hf-bridge] onToolCall threw:", err);
      }
    });

    next.on("error", ({ error }) => {
      console.error("[hf-bridge]", error);
    });

    next.on("transcript", ({ role, text, partial }) => {
      if (role !== "user" || partial) return;
      if (!text) return;
      for (const sub of userTranscriptSubs) {
        try {
          sub(text);
        } catch (err) {
          console.warn("[hf-bridge] user transcript subscriber threw:", err);
        }
      }
    });

    return next;
  };

  const connect = async (robotMicTrack: MediaStreamTrack): Promise<void> => {
    lastMicTrack = robotMicTrack;
    robotMicTrack.enabled = !micMuted;
    const next = buildClient(robotMicTrack);
    client = next;
    connecting = true;
    try {
      await next.connect();
    } finally {
      connecting = false;
    }
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
      "[hf-bridge] connection lost, attempting silent reconnect...",
      cause,
    );
    try {
      deps.onReconnecting();
    } catch (err) {
      console.warn("[hf-bridge] onReconnecting threw:", err);
    }

    try {
      await client?.close();
    } catch (err) {
      console.warn("[hf-bridge] close during reconnect failed:", err);
    }
    client = null;

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));

    try {
      // Re-read `lastMicTrack` instead of using the track captured when
      // the error fired: a phone-side network blip kills the HF socket
      // AND the robot transport, so an SDK re-dial can land inside this
      // backoff window and hand us a fresh receiver track. Reconnecting
      // onto the captured (now dead) one would rebuild the client on a
      // silent uplink - connected, and deaf.
      await connect(lastMicTrack ?? robotMicTrack);
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
      console.warn("[hf-bridge] close failed:", err);
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
      console.warn("[hf-bridge] sendToolResponse failed:", err);
      return false;
    }
  };

  const routeOutputToRobot = (track: MediaStreamTrack): void => {
    const robot = deps.getRobot();
    if (!robot) return;
    const pc = robot.peerConnection;
    if (!pc) return;

    const transceivers = pc.getTransceivers();
    const audioTransceiver = transceivers.find(
      (t) =>
        t.receiver.track?.kind === "audio" ||
        t.sender.track?.kind === "audio",
    );
    const audioSender = audioTransceiver?.sender ?? null;
    if (audioSender) {
      if (
        audioTransceiver &&
        audioTransceiver.direction !== "sendrecv" &&
        audioTransceiver.direction !== "sendonly"
      ) {
        try {
          audioTransceiver.direction = "sendrecv";
        } catch (err) {
          console.warn(
            "[hf-bridge] could not bump transceiver direction:",
            err,
          );
        }
      }
      audioSender.replaceTrack(track).catch((err) => {
        console.error("[hf-bridge] replaceTrack failed", err);
      });
    } else {
      console.warn(
        "[hf-bridge] no audio transceiver on the robot peer; the robot may not support bidirectional audio",
      );
    }

    if (!audioSink) {
      audioSink = document.createElement("audio");
      audioSink.autoplay = true;
      audioSink.muted = true;
      document.body.appendChild(audioSink);
    }
    audioSink.srcObject = new MediaStream([track]);
  };

  const teardownSink = (): void => {
    if (!audioSink) return;
    audioSink.srcObject = null;
    audioSink.remove();
    audioSink = null;
  };

  const realtimePort: RealtimePort = {
    sendEvent: (event) => {
      if (!client) return;
      try {
        client.sendEvent(event);
      } catch (err) {
        console.warn("[hf-bridge] sendEvent via RealtimePort failed:", err);
      }
    },
    onUserTranscript: (cb) => {
      userTranscriptSubs.add(cb);
      return () => userTranscriptSubs.delete(cb);
    },
  };

  const getRobotMicTrack = (
    robotInstance: ReachyMiniInstance,
  ): MediaStreamTrack | null => {
    const pc = robotInstance.peerConnection;
    if (!pc) return null;
    for (const receiver of pc.getReceivers()) {
      if (receiver.track && receiver.track.kind === "audio") {
        return receiver.track;
      }
    }
    return null;
  };

  /**
   * Re-bind both conversation audio legs after the SDK re-dialled the
   * robot session.
   *
   * An auto re-dial closes the old `RTCPeerConnection` and builds a new
   * one, so BOTH legs are stranded on a dead PC: the uplink still reads
   * the old receiver track (silence - `onaudioprocess` keeps firing, so
   * nothing looks broken) and the AI voice was `replaceTrack`-ed onto
   * the old sender. The SDK only re-announces the VIDEO track
   * (`ontrack` emits `videoTrack` alone), so audio has to be re-read
   * from the new receivers by hand.
   *
   * Keeps the realtime session: only the media plumbing is swapped, so
   * the conversation history survives the reconnect. Returns false when
   * the new peer connection has no audio receiver yet.
   */
  const rebindRobotAudio = (robotInstance: ReachyMiniInstance): boolean => {
    const track = getRobotMicTrack(robotInstance);
    if (!track) {
      console.warn(
        "[hf-bridge] re-dial: no audio receiver on the new peer connection",
      );
      return false;
    }
    if (track !== lastMicTrack) {
      lastMicTrack = track;
      track.enabled = !micMuted;
      // `client` is null while `tryReconnect` is between close and
      // re-connect. That's fine and NOT a miss: the assignment above is
      // what the pending `connect()` will read (see `tryReconnect`).
      console.info(
        `[hf-bridge] re-dial: uplink re-bound to ${track.id} (client=${client ? "live" : "reconnecting"})`,
      );
      client?.replaceInputTrack(track);
    }
    // Always re-route: even when the receiver track happens to be the
    // same object, the SENDER belongs to the new peer connection.
    if (lastOutputTrack) routeOutputToRobot(lastOutputTrack);
    return true;
  };

  return {
    connect,
    close,
    sendToolResponse,
    rebindRobotAudio,
    isReconnecting: () => reconnecting,
    resetReconnectCounter: () => {
      reconnectAttempts = 0;
    },
    getRobotMicTrack,
    setMicMuted,
    getRealtimePort: () => realtimePort,
  };
}

function isForwardableStatus(
  status: RealtimeStatus,
): status is RealtimeStatusKind {
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
