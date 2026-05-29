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

export type RealtimeStatusKind =
  | "connected"
  | "user-speaking"
  | "processing"
  | "ai-speaking";

export interface RealtimeToolCallEvent {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RealtimePort {
  sendEvent: (event: Record<string, unknown>) => void;
  onUserTranscript: (cb: (text: string) => void) => () => void;
}

export interface HuggingFaceBridgeDeps {
  getRobot: () => ReachyMiniInstance | null;
  getHfToken: () => string | null;
  voice: string | (() => string);
  composeInstructions: () => string;
  tools?: typeof ROBOT_TOOLS;
  onStatus: (status: RealtimeStatusKind) => void;
  onOutputTrack: (track: MediaStreamTrack) => void;
  onToolCall: (call: RealtimeToolCallEvent) => void;
  onReconnecting: () => void;
  onFatalError: (err: Error) => void;
}

export interface HuggingFaceBridge {
  connect: (robotMicTrack: MediaStreamTrack) => Promise<void>;
  close: () => Promise<void>;
  sendToolResponse: (
    callId: string,
    result: { ok: boolean; message: string },
  ) => boolean;
  isReconnecting: () => boolean;
  resetReconnectCounter: () => void;
  getRobotMicTrack: (robotInstance: ReachyMiniInstance) => MediaStreamTrack | null;
  getRealtimePort: () => RealtimePort;
}

const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 1;

export function createHuggingFaceBridge(
  deps: HuggingFaceBridgeDeps,
): HuggingFaceBridge {
  let client: HuggingFaceRealtimeClient | null = null;
  let audioSink: HTMLAudioElement | null = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let lastMicTrack: MediaStreamTrack | null = null;

  const userTranscriptSubs = new Set<(text: string) => void>();
  const tools = deps.tools ?? ROBOT_TOOLS;

  const buildClient = (
    robotMicTrack: MediaStreamTrack,
  ): HuggingFaceRealtimeClient => {
    const next = new HuggingFaceRealtimeClient({
      getHfToken: deps.getHfToken,
      voice: typeof deps.voice === "function" ? deps.voice() : deps.voice,
      instructions: deps.composeInstructions(),
      inputTrack: robotMicTrack,
      tools,
    });

    next.on("outputTrack", ({ track }) => {
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
    const pc = robot._pc;
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
    isReconnecting: () => reconnecting,
    resetReconnectCounter: () => {
      reconnectAttempts = 0;
    },
    getRobotMicTrack,
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
