/**
 * Shared vision-module types.
 *
 * The only public type exposed outside the module is `VisionHandle`
 * (re-exported by `./index`). Everything else here is internal and
 * shared across the poller, provider, injector and capture submodules.
 */

/** Where a single scene capture came from. */
export type SceneTrigger = "periodic" | "stt_keyword" | "initial";

/** A still frame ready to ship to a VLM. */
export interface CapturedFrame {
  /** Data URL of the JPEG (`data:image/jpeg;base64,…`). Used directly
   *  by providers that accept `image_url` (OpenAI Vision today). */
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
  /** User utterance that triggered the capture (STT-trigger only).
   *  Providers may use it to bias the description toward what the
   *  user likely cares about. */
  userHint?: string;
  /** Caller-controlled abort signal so the poller can cancel an
   *  in-flight VLM call on teardown / interval reset. */
  abortSignal?: AbortSignal;
}
