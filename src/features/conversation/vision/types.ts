/**
 * Shared vision-module types.
 *
 * The only public type exposed outside the module is `VisionHandle`
 * (re-exported by `./index`). Everything else here is internal and
 * shared across the provider, injector and capture submodules.
 */

/** Where a single scene capture came from. Only one path remains:
 *  `look` is the model-driven, on-demand capture behind the `look`
 *  realtime tool. (Kept as a named type rather than inlined so the
 *  injector / cache signatures read intentionally and a future
 *  capture path can be re-introduced without a rename.) */
export type SceneTrigger = "look";

/** Result of an on-demand `look()` (the realtime `look` tool). The
 *  description is meaningful only when `ok` is true; otherwise
 *  `message` explains why the look failed (no video, VLM error) so
 *  the model can relay something sensible to the user. */
export interface LookResult {
  ok: boolean;
  /** Short factual scene description (present when `ok`). */
  description?: string;
  /** Human-readable status/error for the model to act on. */
  message: string;
  /** True when the description was served from the freshness cache
   *  rather than a fresh capture (a prior look taken within the last
   *  `lookCacheFreshnessMs`). */
  cached?: boolean;
}

/** A still frame ready to ship to a VLM. */
export interface CapturedFrame {
  /** Data URL of the JPEG (`data:image/jpeg;base64,…`). Used directly
   *  by providers that accept `image_url` content parts. */
  dataUrl: string;
  /** `performance.now()` timestamp of the capture. Useful for
   *  diagnosing staleness in the logs. */
  capturedAt: number;
  widthPx: number;
  heightPx: number;
}

/** Context passed alongside a frame to the VLM provider. */
export interface DescribeOptions {
  trigger: SceneTrigger;
  /** Optional caller-controlled abort signal to cancel an in-flight
   *  VLM call. Currently unused by `look` (the provider applies its
   *  own hard timeout), kept for provider flexibility. */
  abortSignal?: AbortSignal;
}
