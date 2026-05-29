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
  /** Late-bound accessor for the user's HF token (stored at
   *  `sessionStorage.hf_token` by the OAuth flow). The VLM provider
   *  reads it on every call so a sign-out / sign-in mid-session is
   *  picked up without rebuilding the pipeline. Returning `null`
   *  here at `attachVision` time also short-circuits to a no-op
   *  pipeline (we don't poll if we know we can't authenticate). */
  getHfToken: () => string | null;
}

/**
 * Construct the vision pipeline. Returns a handle the engine drives
 * through the conversation lifecycle (`start()` after a successful
 * Realtime handshake, `dispose()` on teardown).
 *
 * Returns `null` when no HF token is available at construction time
 * (user signed out, or sessionStorage hasn't been hydrated yet). The
 * engine's call sites already tolerate `null` via `vision?.start()`
 * optional chaining, so the absence of a token degrades gracefully
 * to "no scene awareness this session" without breaking the convo.
 */
export function attachVision(deps: AttachVisionDeps): VisionHandle | null {
  if (!deps.getHfToken()) {
    console.warn(
      "[vision] attachVision called without an HF token — feature inert (user not signed in?)",
    );
    return null;
  }

  const provider = createProvider({ getHfToken: deps.getHfToken });
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
