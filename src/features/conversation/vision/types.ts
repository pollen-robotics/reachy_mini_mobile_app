/**
 * Shared vision-module types.
 *
 * The only public type exposed outside the module is `VisionHandle`
 * (re-exported by `./index`). Everything else here is internal and
 * shared with the frame-capture submodule.
 */

/** Result of an on-demand `look()` (the realtime `look` tool). On
 *  success the captured image has been attached to the conversation
 *  as an `input_image` item; `message` tells the model so. On failure
 *  `message` explains why (no video, capture error) so the model can
 *  relay something sensible to the user. */
export interface LookResult {
  ok: boolean;
  /** Human-readable status/error for the model to act on. */
  message: string;
}

/** A still frame ready to attach to the realtime conversation. */
export interface CapturedFrame {
  /** Data URL of the JPEG (`data:image/jpeg;base64,…`). Sent as-is in
   *  the `input_image` content part. */
  dataUrl: string;
  /** `performance.now()` timestamp of the capture. Useful for
   *  diagnosing staleness in the logs. */
  capturedAt: number;
  widthPx: number;
  heightPx: number;
}
