# Android permissions runbook

> Status: implementation runbook / pre-Android-target
> Last reviewed: 2026-05-29
> Owner: mobile team
> Scope: every runtime permission the app needs on Android, where each
> one is declared, who triggers it, and the exact steps to wire the
> WebView so iframe-delegated `getUserMedia` / `getCurrentPosition`
> calls actually prompt the user.
> Companion to:
> [`APP_STORE_COMPLIANCE.md`](./APP_STORE_COMPLIANCE.md) (policy framework)
> and [`APP_STORE_AUDIT_2026-05.md`](./APP_STORE_AUDIT_2026-05.md)
> (iOS submission gap analysis).

This document answers a single question: **what does it take to make
every permission-gated feature work on Android, given that the app is
a Tauri 2 shell whose real surface is a WebView (the host UI) plus a
cross-origin iframe (third-party Hugging Face Spaces)?**

It exists because the permission model on Android WebView is *not*
automatic the way iOS WKWebView is. On iOS, declaring the
`NSXxxUsageDescription` strings + the iframe `allow` tokens is enough;
WKWebView prompts the user on the first `getUserMedia`. On Android, the
host **must** implement two `WebChromeClient` callbacks or the iframe's
media / geolocation calls are silently denied with no prompt.

---

## 0. TL;DR for the release engineer

If you only read one section, read this.

1. Android isn't initialised in the repo. `src-tauri/gen/android/` is
   generated on the fly (locally via `yarn tauri android init`, in CI
   by [`build-mobile.yml`](../.github/workflows/build-mobile.yml)). Any
   manifest / Kotlin patch must therefore be **idempotent and
   re-applied after every `init`** - exactly like the existing
   `reachymini://` intent-filter patch in CI. Do **not** hand-edit
   `gen/android/` and expect it to survive.
2. Three permission families are in play: **microphone**, **camera**,
   **location**. Plus `INTERNET` (auto). See the matrix in section 2.
3. The manifest needs the `<uses-permission>` entries (section 4).
4. The `MainActivity` WebView needs a `WebChromeClient` that implements
   `onPermissionRequest` (mic/camera) and
   `onGeolocationPermissionsShowPrompt` (location), each bridged to the
   Android 6+ **runtime** permission request (section 5). This is the
   step that has no iOS equivalent and is the usual reason "the mic
   works on iOS but not Android".
5. Every permission must be mapped in the Play Console **Data Safety**
   form (section 7) or the listing is blocked at submission.

Time estimate for a release engineer who knows Android: **1-1.5 days**,
most of it spent verifying the `WebChromeClient` path on a real device
across Android 13 / 14 / 15.

---

## 1. Why Android is different from iOS here

The app has two distinct consumers of OS permissions:

| Consumer | What it does | iOS path | Android path |
|---|---|---|---|
| **Host shell** (the conversation feature) | `getUserMedia({audio})` to unlock WebRTC LAN candidates (see [`iosMicUnlock.ts`](../src/features/conversation/permissions/iosMicUnlock.ts)) | WKWebView prompts on first call | WebView calls `onPermissionRequest`; host must launch the runtime request |
| **Iframe** (third-party Spaces) | `getUserMedia`, `getCurrentPosition` from inside a cross-origin `*.hf.space` frame | iframe `allow` tokens + WKWebView prompt | WebView calls `onPermissionRequest` / `onGeolocationPermissionsShowPrompt`; host must forward the grant to the iframe origin |

The iframe `allow` list is already in place and is identical on both
platforms ([`AppIframeOverlay.tsx`](../src/ui/panels/apps-list/AppIframeOverlay.tsx)):

```
allow="microphone 'src'; camera 'src';
       autoplay 'src'; clipboard-read 'src'; clipboard-write 'src'"
```

> Geolocation was previously delegated but removed (2026-06): no
> shipping Space surfaces a location feature, and an unused
> permission prompt is an App Review / Play Console red flag. The
> Android `onGeolocationPermissionsShowPrompt` handler below remains
> documented as the recipe to follow if a Space ever needs it.

`allow` is a *web-platform* feature-policy gate. It says "the iframe is
permitted to ask". It does **not** grant the OS-level permission. On
Android, the OS grant is a separate, mandatory layer that lives in the
native `WebChromeClient`. Getting `allow` right but skipping the
`WebChromeClient` is the single most common failure mode and produces
the exact symptom documented in [`AGENTS.md`](../AGENTS.md) ("works in a
regular browser, silently broken inside Reachy Mini").

---

## 2. Permission matrix

Authoritative list of every permission the shipped Android app needs,
why, and what triggers it.

| Capability | Android permission(s) | Triggered by | Required? | iOS counterpart |
|---|---|---|---|---|
| Network | `android.permission.INTERNET` | Every HTTP/WebRTC/WebSocket call | **Yes** (auto-added by Tauri) | n/a (implicit) |
| Microphone | `android.permission.RECORD_AUDIO`, `android.permission.MODIFY_AUDIO_SETTINGS` | Conversation WebRTC unlock + voice Spaces (`getUserMedia({audio})`) | **Yes** | `NSMicrophoneUsageDescription` |
| Camera | `android.permission.CAMERA` | Vision / AR / barcode Spaces (`getUserMedia({video})`) | Yes (only if a Space uses it) | `NSCameraUsageDescription` |
| ~~Location~~ | ~~`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`~~ | (removed 2026-06 — no Space surfaces geolocation today; the permission was an App Review red flag for a capability we don't use. Re-add if a Space genuinely needs `getCurrentPosition`.) | No | ~~`NSLocationWhenInUseUsageDescription`~~ |
| Local network | (no explicit permission on Android) | Daemon HTTP on `robot:8000` | n/a | `NSLocalNetworkUsageDescription` + `NSAllowsLocalNetworking` |
| Keep screen on | (no permission; `FLAG_KEEP_SCREEN_ON` window flag) | `tauri-plugin-keep-screen-on` during a live session | **Yes** (handled by plugin) | `UIApplication.isIdleTimerDisabled` |
| Background audio | (foreground service or none; see § 6) | Keep WebRTC alive when screen locks | Decision needed | `UIBackgroundModes = audio` |
| OAuth callback | (no permission; intent-filter on `reachymini://`) | HF sign-in via Chrome Custom Tabs | **Yes** (patched in CI today) | `ASWebAuthenticationSession` |

Notes:

- `INTERNET` is added automatically by the Tauri/wry Android template;
  you don't declare it yourself, but confirm it survived `init`.
- Camera is only strictly needed because **third-party Spaces** may
  use it. If product decides to ship the first Android build *without*
  camera-using Spaces visible, you can defer it and the matching Data
  Safety entry. Microphone is non-negotiable (the core conversation
  feature needs it).
- Location was previously declared but removed (2026-06) because no
  shipping Space surfaces a geolocation feature; an unused
  runtime-permission prompt is an App Review / Play Console red flag.

---

## 3. Where the build comes from (so patches land in the right place)

`src-tauri/build.rs` is intentionally minimal:

```rust
fn main() {
    tauri_build::build()
}
```

There is **no** custom `update_android_manifest` call. (An older code
comment in `iosMicUnlock.ts` references one; that is aspirational, not
current - treat this matrix + section 4/5 as the source of truth.)
Permissions therefore arrive in the manifest one of two ways:

1. **Plugin-injected**: Tauri plugins that declare Android permissions
   in their own `AndroidManifest.xml` get merged by the Gradle manifest
   merger. This is how the `auth-session` activity and the keep-screen-on
   flag arrive.
2. **App-injected**: anything the *app itself* needs (mic, camera,
   location for the WebView) must be added to the generated
   `gen/android/app/src/main/AndroidManifest.xml`.

Because `gen/android/` is regenerated on every `tauri android init`, the
app-injected entries must be applied by an **idempotent patch step**,
not committed by hand. The repo already does this for the
`reachymini://` intent-filter - see the "Patch AndroidManifest" steps in
[`build-mobile.yml`](../.github/workflows/build-mobile.yml). Add the
permission patch in the same place, using the same
"check-if-present-then-inject" Python pattern so re-runs are no-ops.

---

## 4. Manifest entries

Target state of the generated
`gen/android/app/src/main/AndroidManifest.xml` (only the
permission-relevant lines shown):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.CAMERA" />
    <!-- ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION removed 2026-06.
         No shipping Space surfaces a geolocation feature; re-add if
         a Space genuinely needs `navigator.geolocation`. -->

    <!-- Declare hardware as NOT required so the app stays installable
         on devices without a camera (the features degrade gracefully;
         only the Spaces that need them are affected). -->
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />

    <application ...>
        <!-- ... existing activities ... -->
        <!-- AuthSessionActivity + reachymini:// intent-filter is
             injected by the existing CI patch; keep both patches
             ordered so neither clobbers the other. -->
    </application>
</manifest>
```

The `android:required="false"` on `<uses-feature>` matters: without it,
Google Play hides the app from any device lacking the hardware, which
would needlessly shrink reach since these capabilities are only used by
*some* Spaces.

---

## 5. The WebChromeClient bridge (the part with no iOS equivalent)

This is the crux. Android WebView routes a frame's `getUserMedia` and
`getCurrentPosition` requests to the host's `WebChromeClient`. If the
host doesn't override the relevant callbacks, WebView's default is to
**deny silently**. The result: `NotAllowedError` inside the iframe and
no system prompt - the exact symptom in `AGENTS.md`.

Tauri's Android backend (wry) installs its own `RustWebChromeClient`.
Depending on the wry version pinned via the Tauri dependency, mic/camera
`onPermissionRequest` handling may already be present, but
**geolocation is not**, and the behaviour has shifted across wry
releases. Do not assume; verify on a device (section 8). When the
default is insufficient, the fix is to subclass / extend the activity's
WebChromeClient in `MainActivity.kt`.

### 5.1 Runtime permission gating

Android 6+ (API 23+) requires the app to hold the *runtime* permission
before WebView can grant the web-layer request. So the bridge is a
two-step dance:

1. WebView callback fires (`onPermissionRequest` for mic/camera,
   `onGeolocationPermissionsShowPrompt` for location).
2. If the app already holds the OS runtime permission, grant the web
   request immediately. Otherwise, launch the runtime permission
   request, and grant/deny the web request based on the result.

### 5.2 Reference implementation (`MainActivity.kt`)

Tauri's generated `MainActivity` extends `TauriActivity`. Override the
WebView's chrome client after the WebView is created. The shape below is
a *runbook reference* - adapt names to the wry version actually pinned:

```kotlin
package com.pollenrobotics.reachymini   // matches the CI-renamed applicationId

import android.Manifest
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager

class MainActivity : TauriActivity() {

    // Cache the pending web-layer requests while we wait for the
    // Android runtime permission dialog to resolve.
    private var pendingPermissionRequest: PermissionRequest? = null
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    override fun onWebViewCreate(webView: android.webkit.WebView) {
        super.onWebViewCreate(webView)
        webView.webChromeClient = object : WebChromeClient() {

            // Mic + camera coming from getUserMedia (host or iframe).
            override fun onPermissionRequest(request: PermissionRequest) {
                val needed = mutableListOf<String>()
                for (res in request.resources) {
                    when (res) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                            needed += Manifest.permission.RECORD_AUDIO
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                            needed += Manifest.permission.CAMERA
                    }
                }
                val missing = needed.filter {
                    ContextCompat.checkSelfPermission(this@MainActivity, it) !=
                        PackageManager.PERMISSION_GRANTED
                }
                if (missing.isEmpty()) {
                    // We already hold the OS grant: approve the web
                    // request for exactly the resources it asked for.
                    request.grant(request.resources)
                } else {
                    pendingPermissionRequest = request
                    ActivityCompat.requestPermissions(
                        this@MainActivity, missing.toTypedArray(), REQ_MEDIA
                    )
                }
            }

            // Location coming from getCurrentPosition / watchPosition.
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
                        REQ_LOCATION
                    )
                }
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val allGranted = grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        when (requestCode) {
            REQ_MEDIA -> {
                pendingPermissionRequest?.let { req ->
                    if (allGranted) req.grant(req.resources) else req.deny()
                }
                pendingPermissionRequest = null
            }
            REQ_LOCATION -> {
                pendingGeoCallback?.invoke(pendingGeoOrigin ?: "", allGranted, false)
                pendingGeoOrigin = null
                pendingGeoCallback = null
            }
        }
    }

    companion object {
        private const val REQ_MEDIA = 4001
        private const val REQ_LOCATION = 4002
    }
}
```

Caveats the implementer must check against the pinned wry version:

- The exact superclass hook (`onWebViewCreate` vs. accessing the
  WebView some other way) depends on the Tauri/wry version. If wry
  already sets a `webChromeClient`, you may need to *wrap* it rather
  than replace it, or wry's mic handling will be lost.
- `request.grant()` must be called on the UI thread.
- For cross-origin iframes, WebView reports the *frame's* origin in the
  geolocation prompt; that's fine - we grant per-origin.

### 5.3 Why not just patch CI like the intent-filter?

The intent-filter is a static manifest snippet, so a regex patch is
fine. The `WebChromeClient` is Kotlin source. Two viable approaches:

1. **CI source patch** (consistent with the intent-filter approach):
   inject the override into the generated `MainActivity.kt` with an
   idempotent patch step. Brittle if Tauri changes the template.
2. **Committed override** under `src-tauri/gen/android` *templated
   inputs* - Tauri supports project-level overrides via
   `src-tauri/android/` source sets that survive `init`. Preferred if
   it works with the pinned Tauri version; verify before relying on it.

Pick one and document it next to the existing manifest patch in
`build-mobile.yml`.

---

## 6. Background audio (decision needed)

iOS uses `UIBackgroundModes = audio` so a voice conversation survives
the screen locking. Android's equivalent is **not** a permission - it's
either:

- a **foreground service** with `android.permission.FOREGROUND_SERVICE`
  + `FOREGROUND_SERVICE_MICROPHONE` (API 34+) and a persistent
  notification, or
- accepting that the WebRTC session pauses when the app is backgrounded.

This is a product call, not a pure engineering one: a foreground service
with a mic notification is heavier (and Play scrutinises
`FOREGROUND_SERVICE_MICROPHONE` declarations). For the first Android
release, **defer** the foreground service and accept that backgrounding
pauses the conversation, unless product says otherwise. Track it as a
follow-up rather than blocking the first submission.

---

## 7. Play Console Data Safety mapping

Every permission above must be reflected in the Play **Data Safety**
form, or submission is blocked. Mapping:

| Data type | Collected? | Shared? | Purpose | Note |
|---|---|---|---|---|
| Audio (microphone) | Yes | Yes (HF realtime backend) | App functionality (voice conversation) | Not stored on Pollen servers; processed by the realtime backend |
| ~~Location (precise)~~ | ~~Only if a Space uses it~~ | n/a | n/a | Removed 2026-06 — no shipping Space surfaces geolocation; the permission was an App Review / Play Console red flag. Restore the row if a Space starts using `navigator.geolocation`. |
| Photos/video (camera) | Only if a Space uses it | Possibly (the Space) | App functionality | Same third-party caveat |
| App activity / identifiers | Yes | Yes (Hugging Face) | Account / auth | HF token + username |

The third-party Spaces caveat must mirror the privacy-policy language
already required by `APP_STORE_COMPLIANCE.md` § 6.5: "third-party apps
you open operate independently and are subject to the privacy policy of
their author".

---

## 8. Device verification checklist

Android permission behaviour fragments hard across OS versions. Before
calling the Android permission work done, verify on real devices (or
emulators) at these API levels:

- [ ] **Android 13 (API 33)** - new granular media permissions baseline.
- [ ] **Android 14 (API 34)** - `FOREGROUND_SERVICE_*` typing (only if § 6 is implemented).
- [ ] **Android 15 (API 35)** - edge-to-edge enforcement (UI, not permissions, but verify the prompt isn't clipped behind system bars).

For each device, run the full path:

- [ ] First launch: conversation mic prompt appears, grant -> WebRTC connects to robot.
- [ ] Deny the mic prompt -> app degrades gracefully (no crash, clear message).
- [ ] Open a mic-using Space in the iframe -> capture works (prompt may not re-appear if host already holds the grant - that's expected, see `AGENTS.md`).
- [ ] Open a camera-using Space -> prompt appears once, then video works.
- ~~[ ] Open a location-using Space~~ — geolocation no longer declared (2026-06). Re-enable this step if/when the manifest re-adds `ACCESS_*_LOCATION`.
- [ ] Revoke a permission in Android Settings, relaunch -> app re-prompts on next use.
- [ ] HF sign-in via Chrome Custom Tabs returns through `reachymini://` (regression check on the intent-filter patch).

Diagnostic when an iframe capability misbehaves: attach
`chrome://inspect/#devices` to the device, switch the DevTools console
to the `*.hf.space` frame, and run the `getUserMedia` snippet from
`AGENTS.md` § "Notes for HF Space authors". `OK` means the native
bridge works and the bug is Space-side; `NotAllowedError` means the
`WebChromeClient` path (section 5) isn't granting.

---

## 9. Open questions

1. **Camera / location in v1?** If the first Android build hides Spaces
   that use camera or location, those permissions + Data Safety entries
   can be deferred. Product decision.
2. **Background audio (§ 6)?** Foreground service now, or accept
   conversation-pauses-on-background for v1?
3. **`WebChromeClient` injection strategy (§ 5.3)?** CI source patch vs.
   committed Android source-set override. Pick one before the first
   signed Android build to avoid drift.

---

## 10. References

- Internal: [`APP_STORE_COMPLIANCE.md`](./APP_STORE_COMPLIANCE.md) - Apple/Google policy framework
- Internal: [`APP_STORE_AUDIT_2026-05.md`](./APP_STORE_AUDIT_2026-05.md) - iOS submission gap analysis
- Internal: [`AGENTS.md`](../AGENTS.md) § "Notes for HF Space authors" - iframe permission behaviour
- Internal: [`build-mobile.yml`](../.github/workflows/build-mobile.yml) - existing idempotent manifest patch pattern
- Internal: [`iosMicUnlock.ts`](../src/features/conversation/permissions/iosMicUnlock.ts) - cross-platform mic-unlock rationale
- [Android WebView `onPermissionRequest`](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequest(android.webkit.PermissionRequest))
- [Android `onGeolocationPermissionsShowPrompt`](https://developer.android.com/reference/android/webkit/WebChromeClient#onGeolocationPermissionsShowPrompt(java.lang.String,%20android.webkit.GeolocationPermissions.Callback))
- [Android runtime permissions](https://developer.android.com/training/permissions/requesting)
- [Play Data Safety form](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Tauri 2 Android distribution](https://v2.tauri.app/distribute/google-play/)
