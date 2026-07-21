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
 *      sendrecv. We immediately replace that track with the assistant
 *      output via `replaceTrack`, then call `releaseSdkPhoneMic` once
 *      the swap is done.
 *
 * Both reasons are mobile-only (no WebKit privacy quirk on macOS
 * desktop, no Android permission prompt to drive). But in
 * `yarn tauri:dev` on Mac the SDK call still opens the host
 * microphone for several seconds (ICE handshake + DC + bringup +
 * backend handshake) — long enough to evict Discord / Zoom / etc.
 * from the system input device.
 *
 * How
 * ───
 * On desktop platforms only (`isDesktopPlatform()` from
 * `./platform.ts`) we patch `MediaDevices.prototype.getUserMedia`
 * via `Object.defineProperty` with `writable: false` and
 * `configurable: false`. We went through three iterations to land
 * here; the explanation matters because a naive instance patch
 * looks correct but quietly stops working in this app:
 *
 *   1. First attempt: `navigator.mediaDevices.getUserMedia = shim`.
 *      Worked in browser dev. In the Tauri WKWebView the patch was
 *      reverted within a few seconds of being installed — the
 *      instance-level shadow disappeared without anyone in our
 *      codebase or its deps writing to that slot. The likely cause
 *      is WKWebView recreating the `navigator.mediaDevices`
 *      instance on a native audio-session event during bring-up
 *      (mic permission gate, audio category change, etc.).
 *
 *   2. Second attempt: patch the prototype. Survives instance
 *      recreation (every recreated `MediaDevices` inherits from
 *      the same prototype), but writable: true left the door open
 *      for an instance-level shadow to win later.
 *
 *   3. Final attempt (this file): prototype patch + `writable:
 *      false, configurable: false`. The slot becomes a one-way
 *      switch for the lifetime of the page context. Any further
 *      assignment silently fails (non-strict) or throws (strict);
 *      any `delete` throws TypeError. The shim is immune to both
 *      WKWebView quirks and accidental downstream resets.
 *
 * Both callers above already handle the rejection in production
 * (it's the "user denied the prompt" path on iOS / Android):
 *
 *   - `iosMicUnlock` logs a warn, its caller `.catch(() => undefined)`s.
 *   - The SDK falls back to a silent oscillator track served from
 *     `AudioContext`, which the bridge happily replaces with the
 *     assistant output via `audioSender.replaceTrack(...)`. Conversation
 *     keeps working end-to-end on desktop dev.
 *
 * Scope
 * ─────
 * Iframes (HF Space embeds in the Apps tab) have their own
 * `MediaDevices.prototype` per `Window`, so this patch lives on the
 * top frame only. Voice / vision Spaces inside the iframe keep
 * their unmodified `getUserMedia` and behave exactly as in
 * production.
 *
 * Video-only requests are passed through untouched (the host app
 * doesn't capture camera, but the symmetric guard is cheap and
 * future-proof).
 *
 * Idempotency + HMR
 * ─────────────────
 * `installDesktopMicShim()` is safe to call any number of times:
 *
 *   - A `__isDesktopMicShim` marker on the patched function lets a
 *     re-call detect the patch is already in place and bail. This
 *     handles the Vite HMR scenario where this module's closures
 *     get recycled but the prototype slot keeps its previous
 *     non-configurable value. Without the marker, a re-call would
 *     try (and fail noisily) to `defineProperty` over a
 *     non-configurable slot.
 *
 *   - The module also self-installs at top level. `main.tsx`
 *     keeps calling `installDesktopMicShim()` for explicitness +
 *     audit (the install side-effect is visible from the entry
 *     point) but the module-level call covers the HMR path where
 *     `main.tsx` does NOT re-evaluate.
 *
 * Audit
 * ─────
 *   - Disable site: don't call `installDesktopMicShim()` AND
 *     remove the module-level auto-install.
 *   - Every interception emits a `console.info` with the
 *     constraints it blocked, so a stray call in a prod-flavoured
 *     build would be loud in the logs.
 *   - No-op (and idempotent) on mobile platforms.
 */
import { isDesktopPlatform } from './platform';

const SHIM_MARKER = '__isDesktopMicShim';

let installed = false;

export function installDesktopMicShim(): void {
  if (installed) return;
  if (!isDesktopPlatform()) return;
  if (typeof MediaDevices === 'undefined') return;
  if (typeof navigator === 'undefined') return;
  if (!navigator.mediaDevices) return;

  const proto = MediaDevices.prototype;
  const existing = proto.getUserMedia as
    | ((constraints?: MediaStreamConstraints) => Promise<MediaStream>)
    | undefined;
  if (!existing || typeof existing !== 'function') return;

  // Re-entrancy guard: prior install (possibly from a HMR'd copy
  // of this module) already swapped the prototype slot. Mark our
  // new closure as installed and return without touching the
  // (now non-configurable) slot, otherwise `defineProperty` would
  // throw TypeError.
  if ((existing as unknown as Record<string, unknown>)[SHIM_MARKER]) {
    installed = true;
    return;
  }

  const realGetUserMedia = existing;

  function shimGetUserMedia(
    this: MediaDevices,
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> {
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
    // Pass-through. `realGetUserMedia.call(this, ...)` because
    // `this` for a prototype method is the live MediaDevices
    // instance, which may not be the boot-time one (see
    // discussion above about WKWebView recreating the instance).
    return realGetUserMedia.call(this, constraints as MediaStreamConstraints);
  }

  (shimGetUserMedia as unknown as Record<string, unknown>)[SHIM_MARKER] = true;

  // Drop any pre-existing instance-level shadow so our prototype
  // patch actually shines through. Common in dev where the
  // previous build of this file patched the instance (or a
  // devtools snippet assigned to that slot for debugging).
  // Best-effort: a non-configurable own shadow would be
  // un-deletable, in which case the instance shadow keeps winning
  // and we log loudly so the regression is obvious.
  try {
    if (Object.prototype.hasOwnProperty.call(navigator.mediaDevices, 'getUserMedia')) {
      delete (navigator.mediaDevices as unknown as Record<string, unknown>).getUserMedia;
    }
  } catch (err) {
    console.warn(
      '[desktop-mic-shim] could not delete stale instance-level getUserMedia shadow; ' +
        'the prototype patch may not take effect:',
      err,
    );
  }

  try {
    Object.defineProperty(proto, 'getUserMedia', {
      value: shimGetUserMedia,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (err) {
    console.warn(
      '[desktop-mic-shim] defineProperty on MediaDevices.prototype failed; ' +
        'shim NOT installed (mic capture stays enabled):',
      err,
    );
    return;
  }

  installed = true;
  console.info(
    '[desktop-mic-shim] installed on MediaDevices.prototype ' +
      '(non-writable, non-configurable). iframes are unaffected.',
  );
}

// Module-level auto-install. Covers two paths the explicit
// `installDesktopMicShim()` call in `main.tsx` can miss:
//
//   - Vite HMR re-evaluates this module without re-evaluating
//     `main.tsx`. The new closures (`installed = false`,
//     `shimGetUserMedia`) would be dormant without this top-level
//     call. Idempotent via the `__isDesktopMicShim` marker.
//
//   - A test / Storybook / future entry-point that doesn't go
//     through `main.tsx` still gets the shim by importing
//     anything that pulls this module in transitively.
installDesktopMicShim();
