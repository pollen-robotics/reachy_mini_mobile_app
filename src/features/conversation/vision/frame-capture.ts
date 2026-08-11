/**
 * Pure helper: turn a live `MediaStream` into a JPEG `CapturedFrame`.
 *
 * Uses an offscreen `<video>` + `<canvas>` pair, drawn synchronously
 * once the video element has emitted `loadedmetadata` (the first
 * frame is then available via `drawImage`). We deliberately avoid
 * `ImageCapture` / `MediaStreamTrackProcessor`:
 *   - `ImageCapture` is missing on Safari / iOS WebKit, which is one
 *     of our target platforms.
 *   - `MediaStreamTrackProcessor` is Chromium-only and not yet
 *     available in the Tauri WKWebView build.
 *
 * The canvas path works everywhere and is fast enough for our usage
 * (one capture per `look` tool call, ~640 px wide).
 *
 * The function is fully self-cleaning: every DOM node and stream
 * binding it creates is released before the promise resolves /
 * rejects, even on the failure path. Safe to call hundreds of times
 * over a long conversation without leaking decoders.
 */

import { VISION_CONFIG } from "./config";
import type { CapturedFrame } from "./types";

interface CaptureOptions {
  /** Wall-time budget for `loadedmetadata` + first frame. Past this
   *  the helper rejects and the caller should treat it as a skipped
   *  tick. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export async function captureFrame(
  stream: MediaStream,
  opts: CaptureOptions = {},
): Promise<CapturedFrame> {
  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length === 0) {
    throw new Error("captureFrame: stream has no video tracks");
  }
  const liveTrack = videoTracks.find((t) => t.readyState === "live");
  if (!liveTrack) {
    throw new Error("captureFrame: no live video track on stream");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const video = document.createElement("video");
  // Hidden, muted, autoplay - we need the element to actually play
  // for `drawImage` to have pixels. `playsInline` + `muted` are the
  // iOS / Safari requirements for autoplay without a user gesture.
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  // Detach from layout so the element doesn't briefly flash on screen
  // during the few frames it takes to settle. `display: none` would
  // disable playback on some browsers, so we move it off-screen instead.
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "-9999px";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);

  const cleanup = (): void => {
    try {
      video.pause();
    } catch {
      // ignored
    }
    video.srcObject = null;
    video.remove();
  };

  try {
    await waitForVideoReady(video, timeoutMs);

    const intrinsicWidth = video.videoWidth || 640;
    const intrinsicHeight = video.videoHeight || 480;
    const scale = Math.min(1, VISION_CONFIG.imageMaxWidth / intrinsicWidth);
    const targetWidth = Math.max(1, Math.round(intrinsicWidth * scale));
    const targetHeight = Math.max(1, Math.round(intrinsicHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("captureFrame: 2D canvas context unavailable");
    }
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

    const dataUrl = canvas.toDataURL("image/jpeg", VISION_CONFIG.imageQuality);
    if (!dataUrl || !dataUrl.startsWith("data:image/jpeg")) {
      throw new Error("captureFrame: canvas.toDataURL returned no JPEG");
    }

    return {
      dataUrl,
      capturedAt: performance.now(),
      widthPx: targetWidth,
      heightPx: targetHeight,
    };
  } finally {
    cleanup();
  }
}

/**
 * Wait for the video to have a usable first frame. We accept either
 * `loadedmetadata` followed by a non-zero readyState, or
 * `canplay`, whichever fires first. Both branches resolve only after
 * the element has actual dimensions (the metadata event sometimes
 * fires with `videoWidth === 0` on the first tick).
 */
function waitForVideoReady(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isVideoReady(video)) {
      resolve();
      return;
    }

    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", onProgress);
      video.removeEventListener("loadeddata", onProgress);
      video.removeEventListener("canplay", onProgress);
      video.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };

    const onProgress = (): void => {
      if (isVideoReady(video)) {
        cleanup();
        resolve();
      }
    };

    const onError = (): void => {
      cleanup();
      reject(new Error("captureFrame: video element errored"));
    };

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`captureFrame: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    video.addEventListener("loadedmetadata", onProgress);
    video.addEventListener("loadeddata", onProgress);
    video.addEventListener("canplay", onProgress);
    video.addEventListener("error", onError);

    // Kick playback. autoplay should already have done it but iOS
    // sometimes needs the explicit nudge. The promise rejection is
    // silently swallowed - the event listeners above are still the
    // source of truth.
    void video.play().catch(() => {
      /* ignored - autoplay restrictions / pre-gesture state */
    });
  });
}

function isVideoReady(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= 2 /* HAVE_CURRENT_DATA */ &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}
