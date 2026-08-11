/**
 * Vision module configuration.
 *
 * The camera is read ONLY on demand, when the model calls the `look`
 * tool - there is no passive/periodic capture. The captured frame is
 * attached directly to the S2S realtime conversation as an
 * `input_image` item (the backend is natively multimodal), so the only
 * knobs left are the JPEG capture parameters.
 */

export const VISION_CONFIG = {
  // JPEG capture parameters. 640 px wide / quality 0.7 lands the
  // base64 payload around 30 - 60 KB, small enough to ride the
  // realtime websocket alongside the audio stream without hiccups.
  imageMaxWidth: 640,
  imageQuality: 0.7,
} as const;
