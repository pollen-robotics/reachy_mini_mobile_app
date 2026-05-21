# Android: enabling iframe permissions

> Status: **scaffold-ready, not yet applied**. The Android Tauri target
> has not been initialised in this repo (`src-tauri/gen/android/`
> does not exist yet). This doc is the runbook to follow once
> Android is enabled. iOS is fully wired in `src-tauri/Info.plist`
> and via the iframe `allow=` tokens in `AppIframeOverlay.tsx`.

The mobile app embeds HF Spaces in an `<iframe>` and delegates
capabilities to them via `allow="microphone 'src'; camera 'src';
geolocation 'src'; ..."`. On iOS that is enough (WKWebView reads the
`Info.plist` usage strings and prompts the user automatically). On
Android it is **not** enough: even with the OS-level permissions
granted, Android WebView **silently denies** iframe `getUserMedia`
and `getCurrentPosition` calls until the host app:

1. Declares the corresponding `<uses-permission>` entries in the
   `AndroidManifest.xml`.
2. Implements `WebChromeClient.onPermissionRequest` (mic, camera,
   etc.) and `WebChromeClient.onGeolocationPermissionsShowPrompt`
   (geolocation) and grants the iframe what the user already
   approved at the OS level.

Tauri 2 does not handle either step automatically; both have to be
applied by the host app once the Android target exists.

## 1. Initialise the Android target

```bash
# Prerequisites: Android Studio + SDK + NDK + Java 17.
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/<version>"
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"

cd reachy_mini_mobile_app
yarn tauri android init
```

This generates `src-tauri/gen/android/` with the Gradle scaffold,
including:

- `gen/android/app/src/main/AndroidManifest.xml`
- `gen/android/app/src/main/java/com/pollen_robotics/reachy_mini/MainActivity.kt`

Both files are intended to be **edited manually** and committed.
Treat them like any other source file in the repo.

## 2. Patch the AndroidManifest.xml

Inside the `<manifest>` element, before `<application>`, append the
following block:

```xml
<!--
    Permissions delegated to iframe-hosted HF Spaces. Mirrors the
    iOS `Info.plist` keys (NSMicrophoneUsageDescription /
    NSCameraUsageDescription / NSLocationWhenInUseUsageDescription)
    and the iframe `allow=` tokens in
    `src/ui/panels/apps-list/AppIframeOverlay.tsx`. See
    `docs/ANDROID_PERMISSIONS.md` for the rationale.
-->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />

<!--
    Mark camera + location as optional features so the app can
    still install on devices without the hardware. Without these,
    Google Play filters the listing to devices that have all of
    them, which excludes some tablets that lack a rear camera or
    a GPS chip.
-->
<uses-feature
    android:name="android.hardware.camera"
    android:required="false" />
<uses-feature
    android:name="android.hardware.location"
    android:required="false" />
<uses-feature
    android:name="android.hardware.microphone"
    android:required="false" />
```

## 3. Wire WebChromeClient in MainActivity.kt

The default `MainActivity.kt` extends `TauriActivity` and does not
override the WebChromeClient. We need to install our own
client that:

- maps iframe `onPermissionRequest` to `RECORD_AUDIO` /
  `CAMERA` runtime grants,
- maps `onGeolocationPermissionsShowPrompt` to
  `ACCESS_FINE_LOCATION`.

Replace the body of `gen/android/app/src/main/java/com/pollen_robotics/reachy_mini/MainActivity.kt`
with the following (adjust the package name to match the one Tauri
generated):

```kotlin
package com.pollen_robotics.reachy_mini

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.TauriActivity

/**
 * Tauri Android entry point.
 *
 * Hooks a custom [WebChromeClient] so iframe-hosted HF Spaces get
 * the same mic / camera / geolocation capabilities the iOS build
 * already enjoys. Without this override Android WebView silently
 * denies every iframe permission request, even when the OS-level
 * grant is in place. See `docs/ANDROID_PERMISSIONS.md` for the
 * full chain of reasoning.
 *
 * The override is intentionally permissive: any iframe request
 * the OS has already approved is mirrored to the iframe. The
 * Permissions Policy delegation in `AppIframeOverlay.tsx`
 * (`allow="microphone 'src'; ..."`) is the gate upstream; if a
 * Space ends up loaded that doesn't carry the token, the WebView
 * never raises the request in the first place.
 */
class MainActivity : TauriActivity() {
    /**
     * Hook called by Tauri after the WebView has been created.
     * The exact override name moves slightly between Tauri 2.x
     * minors - check `wry`'s `WebChromeClient` integration on the
     * version in `Cargo.toml` and rename if the signature differs.
     */
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // applicationContext is process-scoped, so it's safe to
        // hold for the lifetime of the chrome client without
        // leaking the Activity.
        webView.webChromeClient = ReachyWebChromeClient(applicationContext)
    }
}

private class ReachyWebChromeClient(
    private val appContext: Context,
) : WebChromeClient() {
    /**
     * Mic / camera / etc. - resources that need a runtime
     * `dangerous` permission. Each requested resource is mapped
     * to its Android counterpart; the request is granted only
     * for the resources the OS has already granted to the host
     * app, anything else is denied so the iframe receives a
     * clean `NotAllowedError` instead of a hang.
     */
    override fun onPermissionRequest(request: PermissionRequest) {
        val granted = mutableListOf<String>()
        for (resource in request.resources) {
            val osPerm = when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                else -> null
            }
            if (osPerm != null && hasGranted(osPerm)) {
                granted.add(resource)
            }
        }
        if (granted.isEmpty()) {
            request.deny()
        } else {
            request.grant(granted.toTypedArray())
        }
    }

    /**
     * Geolocation. WebView surfaces this through a different
     * callback than [onPermissionRequest] (legacy quirk dating
     * back to the pre-runtime-permissions era). We mirror the
     * `ACCESS_FINE_LOCATION` grant and pass `retain = false`
     * so the prompt is re-asked across sessions if the OS
     * grant is revoked.
     */
    override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
    ) {
        val ok = hasGranted(Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasGranted(Manifest.permission.ACCESS_COARSE_LOCATION)
        callback.invoke(origin, ok, /* retain = */ false)
    }

    private fun hasGranted(permission: String): Boolean =
        // ContextCompat.checkSelfPermission resolves to a no-op
        // grant on pre-M (API < 23) where install-time perms were
        // the only thing that existed. Safe to call from any API
        // level.
        ContextCompat.checkSelfPermission(appContext, permission) ==
            PackageManager.PERMISSION_GRANTED
}
```

If `MainActivity` is missing `onWebViewCreate` on the version of
Tauri pinned in `Cargo.toml`, the equivalent in older 2.x lines
is to override `onCreate` and call `webView.webChromeClient = ...`
on the `tauriWebView` field directly. Either way the goal is the
same: install our `WebChromeClient` before the first iframe loads.

## 4. Runtime permission UX

The manifest only lists the permissions; the user still has to
grant each one at runtime (Android 6+). Two approaches:

- **Lazy** (status quo, simplest): the first iframe that calls
  `getUserMedia` / `getCurrentPosition` triggers the system
  prompt via [`onPermissionRequest`] / `onGeolocationPermissionsShowPrompt`
  the first time. Subsequent calls reuse the grant.
- **Eager** (smoother UX): request the trio up-front from the
  Apps tab onboarding, mirroring how the iOS first-launch flow
  works. Adds ~1 screen of setup, currently out of scope.

Either way, the screen-level prompt copy can be customised via
`<string name="permission_audio_rationale">...</string>` in
`gen/android/app/src/main/res/values/strings.xml`.

## 5. Verification checklist

Once 1-3 are applied:

- `yarn android:dev` boots an emulator and the app launches.
- Search the catalog for [`cduss/gps_test`](https://huggingface.co/spaces/cduss/gps_test);
  open it; tap "Get position"; the Android system prompt
  appears; grant; the iframe receives coordinates.
- Same drill for any mic / camera Space (e.g. `pollen-robotics/reachy_mini_conversation_app`).
- Cross-check via `chrome://inspect/#devices` if anything
  silently fails - the snippet in `AGENTS.md`'s "Notes for HF
  Space authors" section works the same way on Android.
