/**
 * Realtime backend contract.
 *
 * The conversation engine talks to ONE interface (`RealtimeBackend`) and
 * never to a concrete client. The Hugging Face bridge
 * (`bridge/huggingface-bridge.ts`) is the sole implementation today; the
 * interface is kept as a clean seam so the engine stays agnostic of the
 * transport details. Provider auth (the user's HF token) stays INSIDE the
 * bridge's own deps, never in the shared `RealtimeBackendDeps`.
 */

import type { ROBOT_TOOLS } from "../tools";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

/** Coarse, UI-facing conversation status. The bridge normalises its
 *  finer-grained client states down to this set before forwarding. */
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

/**
 * Generic side-channel port for modules that interact with the realtime
 * data channel without owning the client lifecycle (vision scene
 * injection, future memory/telemetry). Reconnect-survivable: subscribe
 * once, the bridge re-attaches listeners on every fresh client build.
 */
export interface RealtimePort {
  /** Send a raw client event to the active data channel. No-op when no
   *  live client exists yet (between an error and the silent retry). */
  sendEvent: (event: Record<string, unknown>) => void;
  /** Subscribe to completed user-side STT transcripts. Fires once per
   *  finalised utterance with the full text. Returns an unsubscribe. */
  onUserTranscript: (cb: (text: string) => void) => () => void;
}

/**
 * Deps the backend needs from the engine. The provider auth
 * (`getHfToken`) is intentionally absent - it is injected by the backend
 * controller, not the engine, so the engine never has to know which
 * credential the backend uses.
 */
export interface RealtimeBackendDeps {
  getRobot: () => ReachyMiniInstance | null;
  /** Stable robot identity used for deployed backend attribution. */
  getRobotHardwareId: () => string | null;
  voice: string | (() => string);
  /**
   * ISO 639-1 code for the input transcription model. Resolved lazily
   * (re-read on every connect / reconnect) so a language change is
   * picked up without rebuilding the backend. Consumed by the Hugging
   * Face bridge to bias its transcriber.
   */
  transcriptionLanguage: string | (() => string);
  composeInstructions: () => string;
  tools?: typeof ROBOT_TOOLS | (() => typeof ROBOT_TOOLS);
  onStatus: (status: RealtimeStatusKind) => void;
  onOutputTrack: (track: MediaStreamTrack) => void;
  onToolCall: (call: RealtimeToolCallEvent) => void;
  onReconnecting: () => void;
  onFatalError: (err: Error) => void;
}

/**
 * The contract the engine drives. `createHuggingFaceBridge` returns a
 * value assignable to this.
 */
export interface RealtimeBackend {
  connect: (robotMicTrack: MediaStreamTrack) => Promise<void>;
  close: () => Promise<void>;
  sendToolResponse: (
    callId: string,
    result: { ok: boolean; message: string },
  ) => boolean;
  isReconnecting: () => boolean;
  resetReconnectCounter: () => void;
  getRobotMicTrack: (
    robotInstance: ReachyMiniInstance,
  ) => MediaStreamTrack | null;
  setMicMuted: (muted: boolean) => void;
  getRealtimePort: () => RealtimePort;
}
