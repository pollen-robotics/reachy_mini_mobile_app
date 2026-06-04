/**
 * Realtime backend contract.
 *
 * The conversation engine talks to ONE interface (`RealtimeBackend`) and
 * never to a concrete provider. Each provider (Hugging Face, OpenAI) ships
 * a bridge that satisfies this contract; `createRealtimeBackend()` (see
 * `./index.ts`) picks one at session start.
 *
 * The shape here is derived 1:1 from what `conversation-engine` consumes
 * today - it is a *name* for a contract both bridges already satisfied
 * de facto, not a new concept. Provider-specific auth (HF token vs OpenAI
 * ephemeral key) stays INSIDE each bridge's own deps, never in the shared
 * `RealtimeBackendDeps`.
 */

import type { ROBOT_TOOLS } from "../tools";
import type { ReachyMiniInstance } from "@/features/robot-session/sdk-types";

/** Selectable realtime providers. Add a member + a `case` in the factory
 *  to introduce a new backend. */
export type RealtimeBackendKind = "huggingface" | "openai";

/** Coarse, UI-facing conversation status. Both providers normalise their
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
 * Deps every backend needs, regardless of provider. The provider auth
 * (`getHfToken` / `getApiKey`) is intentionally absent - the factory
 * injects it per provider so the engine never has to know which
 * credential the active backend uses.
 */
export interface RealtimeBackendDeps {
  getRobot: () => ReachyMiniInstance | null;
  voice: string | (() => string);
  composeInstructions: () => string;
  tools?: typeof ROBOT_TOOLS | (() => typeof ROBOT_TOOLS);
  onStatus: (status: RealtimeStatusKind) => void;
  onOutputTrack: (track: MediaStreamTrack) => void;
  onToolCall: (call: RealtimeToolCallEvent) => void;
  onReconnecting: () => void;
  onFatalError: (err: Error) => void;
}

/**
 * The contract the engine drives. Both `createHuggingFaceBridge` and
 * `createOpenaiBridge` return a value assignable to this.
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
