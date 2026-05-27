/**
 * Desktop-only microphone capture suppressor.
 *
 * Why
 * ───
 * Two code paths request `navigator.mediaDevices.getUserMedia({audio:true})`
 * during a WebRTC session bring-up:
 *
 *   1. `features/conversation/permissions/iosMicUnlock.ts` — kicks
 *      iOS WKWebView's privacy gate that hides LAN host ICE candidates
 *      until any media permission is granted, and triggers Android
 *      wry's `RECORD_AUDIO` prompt as a side effect.
 *
 *   2. `@pollen-robotics/reachy-mini-sdk` — inside `startSession()`,
 *      grabs an audio track so the WebRTC sender is negotiated
 *      sendrecv. We immediately replace that track with OpenAI's
 *      output via `replaceTrack`, then call `releaseSdkPhoneMic` once
 *      the swap is done.
 *
 * Both reasons are mobile-only (no WebKit privacy quirk on macOS
 * desktop, no Android permission prompt to drive). But in
 * `yarn tauri:dev` on Mac the SDK call still opens the host
 * microphone for several seconds (ICE handshake + DC + bringup +
 * OpenAI handshake) — long enough to evict Discord / Zoom / etc.
 * from the system input device.
 *
 * How
 * ───
 * On desktop platforms only (`isDesktopPlatform()` from
 * `./platform.ts`) we intercept `getUserMedia` *at the top frame*
 * and reject any audio-only request with `NotAllowedError`. Both
 * callers above already handle that error in production (it's the
 * "user denied the prompt" path on iOS / Android):
 *
 *   - `iosMicUnlock` logs a warn, its caller `.catch(() => undefined)`s.
 *   - The SDK falls back to a silent oscillator track served from
 *     `AudioContext`, which the bridge happily replaces with the
 *     OpenAI output via `audioSender.replaceTrack(...)`. Conversation
 *     keeps working end-to-end on desktop dev.
 *
 * Scope
 * ─────
 * Iframes (HF Space embeds in the Apps tab) have their own
 * `MediaDevices` instance per `Window`. This patch lives on the top
 * frame only, so voice / vision Spaces keep their unmodified
 * `getUserMedia` and behave exactly as in production.
 *
 * Video-only requests are passed through untouched (the host app
 * doesn't capture camera, but the symmetric guard is cheap and
 * future-proof).
 *
 * Audit
 * ─────
 *   - Disable site: don't call `installDesktopMicShim()`.
 *   - Every interception emits a `console.info` with the constraints
 *     it blocked, so a stray call in a prod-flavoured build would be
 *     loud in the logs.
 *   - No-op (and idempotent) on mobile platforms.
 */
import { isDesktopPlatform } from './platform';

let installed = false;

export function installDesktopMicShim(): void {
  if (installed) return;
  if (!isDesktopPlatform()) return;
  if (typeof navigator === 'undefined') return;
  if (!navigator.mediaDevices?.getUserMedia) return;

  const realGetUserMedia =
    navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = (
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    const wantsAudio = Boolean(constraints?.audio);
    const wantsVideo = Boolean(constraints?.video);
    if (wantsAudio && !wantsVideo) {
      console.info(
        '[desktop-mic-shim] blocked getUserMedia({audio:true}); ' +
          'caller will fall through to silent-oscillator fallback ' +
          '(desktop dev only).',
        constraints,
      );
      return Promise.reject(
        new DOMException(
          'Microphone capture is disabled on desktop dev builds to avoid ' +
            'evicting other apps (Discord, Zoom, ...) from the system input.',
          'NotAllowedError',
        ),
      );
    }
    return realGetUserMedia(constraints);
  };

  installed = true;
  console.info(
    '[desktop-mic-shim] installed: audio-only getUserMedia will reject on ' +
      'the top frame. iframes are unaffected.',
  );
}
