/**
 * Vision module · public façade.
 *
 * The single attach point the conversation engine talks to. Two
 * exports:
 *
 *   - `attachVision(deps)` wires the VLM provider + scene injector to
 *     the live `RealtimePort` and returns a `VisionHandle` exposing a
 *     single on-demand `look()` (backing the realtime `look` tool).
 *   - `getVisionPromptAppendix()` returns the system-prompt fragment
 *     the engine concatenates into `composeInstructions()`.
 *
 * There is NO passive/periodic capture: the camera is read only when
 * the model deliberately calls the `look` tool (i.e. the user asked it
 * to look at something). Nothing is captured otherwise.
 *
 * Removal procedure (see `docs/VISION.md` § 12):
 *
 *   1. `rm -rf src/features/conversation/vision/`
 *   2. Remove the `attachVision` / `getVisionPromptAppendix` import
 *      + call sites in `conversation-engine.ts` (3-4 lines) and drop
 *      the `look` tool from `tools.ts` / the tool-call handler.
 *
 * No env vars to clean up, no localStorage migration. The bridge's
 * `RealtimePort` + `getRealtimePort()` can stay (useful for any future
 * side-channel) or be reverted for cleanliness.
 */

import { VISION_CONFIG } from "./config";
import { captureFrame } from "./frame-capture";
import type { RealtimePort } from "../engine/realtime/types";
import { createProvider } from "./providers/factory";
import { createSceneCache } from "./scene-cache";
import { createSceneInjector } from "./scene-injector";
import type { LookResult } from "./types";

export interface VisionHandle {
  /** Terminal release. After this, `look()` returns a graceful
   *  failure instead of capturing. Idempotent. */
  dispose: () => void;
  /** On-demand capture for the realtime `look` tool: returns a fresh
   *  scene description (or a recent cached one if a prior look is
   *  still fresh), so the model can answer "what do you see?" within
   *  the same turn. Never throws - failures come back as
   *  `{ ok: false, message }`. */
  look: () => Promise<LookResult>;
}

export interface AttachVisionDeps {
  /** Side-channel port onto the live realtime websocket.
   *  Obtained from `realtimeBridge.getRealtimePort()`. Used to mirror
   *  a `look` result back into the conversation context so later
   *  turns can reference "what you saw" without another look. */
  realtime: RealtimePort;
  /** Live accessor onto the robot's WebRTC video stream. Returning
   *  `null` makes `look()` fail gracefully (camera not live yet). */
  getVideoStream: () => MediaStream | null;
  /** Late-bound accessor for the user's HF token (stored at
   *  `sessionStorage.hf_token` by the OAuth flow). The VLM provider
   *  reads it on every call so a sign-out / sign-in mid-session is
   *  picked up without rebuilding the pipeline. Returning `null`
   *  here at `attachVision` time short-circuits to a no-op pipeline
   *  (we can't authenticate, so `look` is unavailable). */
  getHfToken: () => string | null;
}

/**
 * Construct the vision pipeline. Returns a handle the engine exposes
 * to the `look` tool. There is no lifecycle to drive (no timers, no
 * subscriptions) - `look()` is invoked on demand and `dispose()` is
 * called on teardown.
 *
 * Returns `null` when no HF token is available at construction time
 * (user signed out, or sessionStorage hasn't been hydrated yet). The
 * engine's call sites already tolerate `null` via optional chaining,
 * so the absence of a token degrades gracefully to "no `look` this
 * session" without breaking the convo.
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
  // Freshness cache: a `look` fired right after a previous one reuses
  // the recent description instead of re-capturing (the scene almost
  // never changes within a few seconds).
  const cache = createSceneCache();

  let disposed = false;

  // Guard against parallel `look()` calls (the model double-firing the
  // tool): the second await piggybacks on the first's result instead
  // of kicking off a second capture + VLM round-trip.
  let inFlightLook: Promise<LookResult> | null = null;

  const look = (): Promise<LookResult> => {
    if (disposed) {
      return Promise.resolve({
        ok: false,
        message: "vision is not available in this session",
      });
    }
    if (inFlightLook) return inFlightLook;
    const run = doLook().finally(() => {
      inFlightLook = null;
    });
    inFlightLook = run;
    return run;
  };

  const doLook = async (): Promise<LookResult> => {
    // 1. Freshness short-circuit: reuse a very recent description
    //    rather than re-capturing for a scene that hasn't changed.
    const recent = cache.get();
    if (recent && cache.ageMs() < VISION_CONFIG.lookCacheFreshnessMs) {
      console.info(
        `[vision] look: served from cache (${Math.round(cache.ageMs())}ms old)`,
      );
      return {
        ok: true,
        description: recent.description,
        message: recent.description,
        cached: true,
      };
    }

    // 2. Fresh capture.
    const stream = deps.getVideoStream();
    if (!stream) {
      console.warn("[vision] look: no video stream available");
      return {
        ok: false,
        message:
          "Vision failed: no live camera feed from the robot right now. " +
          "Tell the user you can't see at the moment and offer to try again.",
      };
    }

    try {
      const frame = await captureFrame(stream);
      const description = await provider.describeScene(frame, {
        trigger: "look",
      });
      cache.set(description, "look");
      // Mirror it into the conversation context too, so later turns
      // can still reference "what you saw" without another look.
      injector.inject(description, "look");
      console.info(`[vision] look: fresh capture (${description.length} chars)`);
      return { ok: true, description, message: description };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("[vision] look: capture/VLM failed:", reason);
      return {
        ok: false,
        message:
          `Vision failed: ${reason}. ` +
          "Tell the user you couldn't get a clear look just now and " +
          "offer to try again, rather than guessing what you saw.",
      };
    }
  };

  return {
    dispose: () => {
      disposed = true;
    },
    look,
  };
}

export { getVisionPromptAppendix } from "./prompt-fragment";
