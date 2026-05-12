/**
 * Vision module · public façade.
 *
 * The single attach point the conversation engine talks to. Two
 * exports:
 *
 *   - `attachVision(deps)` wires the poller + provider + injector
 *     to the live `RealtimePort` and returns a `VisionHandle` the
 *     engine drives through its conversation lifecycle.
 *   - `getVisionPromptAppendix()` returns the system-prompt fragment
 *     the engine concatenates into `composeInstructions()`.
 *
 * Removal procedure (see `docs/VISION.md` § 12):
 *
 *   1. `rm -rf src/features/conversation/vision/`
 *   2. Remove the `attachVision` / `getVisionPromptAppendix` import
 *      + call sites in `conversation-engine.ts` (4-5 lines).
 *
 * No env vars to clean up, no localStorage migration, no prompt
 * rewrite. The bridge's `RealtimePort` + `getRealtimePort()` can stay
 * (useful for any future side-channel) or be reverted for cleanliness.
 */

import type { RealtimePort } from "../engine/bridge/openai-bridge";
import { createProvider } from "./providers/factory";
import { createSceneInjector } from "./scene-injector";
import { createScenePoller } from "./scene-poller";

export interface VisionHandle {
  /** Begin the polling + STT subscription. Idempotent; calling
   *  `start()` on an already-started handle is a no-op. */
  start: () => void;
  /** Stop timers + unsubscribe from STT. Idempotent. The handle
   *  can be re-`start()`ed later. */
  stop: () => void;
  /** Terminal release. After this, `start()` becomes a no-op. */
  dispose: () => void;
}

export interface AttachVisionDeps {
  /** Side-channel port onto the live OpenAI Realtime data channel.
   *  Obtained from `openaiBridge.getRealtimePort()`. */
  realtime: RealtimePort;
  /** Live accessor onto the robot's WebRTC video stream. Returning
   *  `null` simply causes the current tick to be skipped (logged at
   *  `debug` level). */
  getVideoStream: () => MediaStream | null;
  /** OpenAI API key. Reused for the Chat Completions / Vision call. */
  openaiApiKey: string;
}

/**
 * Construct the vision pipeline. Returns a handle the engine drives
 * through the conversation lifecycle (`start()` after a successful
 * Realtime handshake, `dispose()` on teardown).
 *
 * Currently always returns a `VisionHandle` (the killswitch was
 * dropped in favour of file-level removability). The function still
 * returns a nullable type to keep the engine's call sites
 * (`vision?.start()`) tolerant of a future re-introduction.
 */
export function attachVision(deps: AttachVisionDeps): VisionHandle | null {
  if (!deps.openaiApiKey) {
    console.warn(
      "[vision] attachVision called without an OpenAI API key — feature inert",
    );
    return null;
  }

  const provider = createProvider({ openaiApiKey: deps.openaiApiKey });
  const injector = createSceneInjector({ realtime: deps.realtime });
  const poller = createScenePoller({
    provider,
    injector,
    getVideoStream: deps.getVideoStream,
    subscribeUserTranscript: deps.realtime.onUserTranscript,
  });

  return {
    start: poller.start,
    stop: poller.stop,
    dispose: poller.dispose,
  };
}

export { getVisionPromptAppendix } from "./prompt-fragment";
