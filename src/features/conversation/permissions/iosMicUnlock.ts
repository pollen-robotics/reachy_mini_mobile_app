/**
 * WebRTC mic-permission pre-flight (mis-named for historical reasons -
 * the file started life as iOS-only but the call is now run on every
 * platform).
 *
 * Why we open the mic at all
 * ──────────────────────────
 * The phone's microphone is NOT used as an audio source: the user's
 * voice is captured by the robot's onboard mic and pushed over the
 * SDK's `RTCPeerConnection`. We still need to `getUserMedia({audio:true})`
 * on the phone for two platform-specific reasons:
 *
 *   - **iOS WKWebView**. Safari/WKWebView deliberately omit LAN host
 *     candidates (`192.168.x.x`) from `RTCIceCandidate` until any
 *     media permission has been granted, to avoid leaking the user's
 *     local IP - see
 *     https://webkit.org/blog/7763/a-closer-look-into-webrtc/. Without
 *     that grant the iPhone's `RTCPeerConnection` advertises **zero**
 *     host candidates and ICE cannot find a LAN path to the robot.
 *
 *   - **Android (Tauri / wry)**. `getUserMedia({audio:true})` triggers
 *     wry's `RustWebChromeClient.onPermissionRequest`, which in turn
 *     calls `permissionLauncher.launch([RECORD_AUDIO,
 *     MODIFY_AUDIO_SETTINGS])` and surfaces the system prompt. Without
 *     this call the user never sees the prompt and `getUserMedia`
 *     rejects with `NotAllowedError`.
 *
 *     Status today: the Tauri Android target isn't initialised in this
 *     repo and the two `*_AUDIO` permissions are not declared anywhere
 *     (no `android.permissions` in `tauri.conf.json`, no manifest patch
 *     in CI). The full Android bring-up runbook lives in
 *     `docs/ANDROID_PERMISSIONS.md`; until that's executed, this call
 *     is a no-op on Android.
 *
 * In both cases we immediately stop the returned tracks. The function
 * is idempotent: subsequent calls are no-ops once the first grant has
 * gone through.
 *
 * Where it's called from
 * ──────────────────────
 * The single caller today is the conversation engine's `doConnect()`,
 * which runs after the user taps a robot row on the ScanScreen and
 * before the SDK's `connect()` kicks off ICE gathering. We don't have
 * an up-front permissions onboarding screen, so this is also the call
 * site that surfaces the OS prompt the very first time.
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
