/**
 * WebRTC mic-permission pre-flight (mis-named for historical reasons -
 * the file started life as iOS-only but the call is now run on every
 * platform).
 *
 * iOS WKWebView. Safari/WKWebView deliberately omit LAN host candidates
 * (`192.168.x.x`) from `RTCIceCandidate` until any media permission
 * has been granted, to avoid leaking the user's local IP - see
 * https://webkit.org/blog/7763/a-closer-look-into-webrtc/. Without that
 * grant the iPhone's `RTCPeerConnection` advertises **zero** host
 * candidates and ICE cannot find a LAN path to the robot.
 *
 * Android (Tauri / wry). `getUserMedia({audio:true})` triggers wry's
 * `RustWebChromeClient.onPermissionRequest`, which in turn calls
 * `permissionLauncher.launch([RECORD_AUDIO, MODIFY_AUDIO_SETTINGS])`
 * and surfaces the system prompt. Both permissions are declared in the
 * generated `AndroidManifest.xml` via `tauri-build::update_android_manifest`
 * (see `src-tauri/build.rs`). Without this call the user never sees the
 * prompt and `getUserMedia` rejects with `NotAllowedError`.
 *
 * In both cases we don't actually need the phone's microphone (audio
 * is captured on the robot, the phone only renders the OpenAI track):
 * we immediately stop the returned tracks. The function is idempotent
 * - subsequent calls are no-ops once the first grant has gone through.
 *
 * Desktop. Neither quirk applies, and grabbing the host mic in
 * `yarn tauri:dev` evicts Discord / Zoom / etc. from the system input.
 * `shared/desktop-mic-shim.ts` rejects the `getUserMedia` call at the
 * navigator level so the `catch` branch below trips: we log a warn
 * and abandon, exactly like the iOS-denied path in production.
 *
 * This module is the single source of truth for that unlock so it can
 * be invoked from both the up-front permissions onboarding screen
 * (preferred path - happens once at first launch, in the user-gesture
 * frame of the "Continue" button) and the conversation engine's
 * `doConnect()` (defensive fallback in case onboarding was skipped or
 * the prompt was denied earlier).
 */

let unlocked = false;

export function isIosMicUnlocked(): boolean {
  return unlocked;
}

export async function unlockIosMicForWebRtc(): Promise<void> {
  if (unlocked) return;
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    unlocked = true;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* noop */
      }
    }
    unlocked = true;
    console.info(
      '[ice-unlock] iOS LAN candidates unlocked via getUserMedia',
    );
  } catch (err) {
    console.warn(
      '[ice-unlock] getUserMedia({audio:true}) failed; LAN host candidates may stay hidden on iOS',
      err,
    );
    throw err;
  }
}
