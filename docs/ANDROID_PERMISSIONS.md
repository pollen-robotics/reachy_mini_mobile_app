# Android permissions runbook

Status: **not executed yet**. The Tauri Android target is not
initialised in this repo (`src-tauri/gen/android/` is absent and the
CI workflow does not build an Android APK). This document captures
the work needed to bring the platform up to feature-parity with iOS
for everything that touches a privileged native capability:

- the host's own **voice conversation** (`getUserMedia({audio})` from
  `features/conversation/permissions/iosMicUnlock.ts`)
- the iframe-delegated capabilities granted to third-party HF Spaces
  in `ui/panels/apps-list/AppIframeOverlay.tsx`
  (`microphone`, `camera`, `geolocation`, `autoplay`, `clipboard-*`)

The matching iOS side is already wired (`src-tauri/Info.plist` usage
strings, CI patches in `.github/workflows/build-mobile.yml`). The
work below is the mirror of that on Android.

## TL;DR - five things to do

1. `yarn tauri android init` from `src-tauri/` to generate
   `src-tauri/gen/android/`.
2. Declare the host's runtime permissions in the generated
   `AndroidManifest.xml` (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`,
   `CAMERA`, `ACCESS_FINE_LOCATION`).
3. Patch the manifest in CI the same way we patch
   `Info.plist` for iOS, so a fresh `tauri android init` on a CI runner
   doesn't lose the entries.
4. Add a custom `WebChromeClient` in `MainActivity.kt` that maps
   `onPermissionRequest` and `onGeolocationPermissionsShowPrompt` to
   the OS grant - the default Tauri / wry client denies iframe
   `getUserMedia` / `getCurrentPosition` outright.
5. Add an `android` job to the build workflow (mirror of the existing
   `android` debug job, plus a release job that signs and uploads to
   the Play Console - the secret names are already documented in
   `.github/workflows/build-mobile.yml`).

Until step 1 happens nothing on the Android path is wired up,
including the host conversation's mic unlock - the `getUserMedia`
call in `iosMicUnlock.ts` will reject with `NotAllowedError` on any
sideloaded debug APK that ships without these permissions.

## Why both layers matter

Android WebView permission flow has two gates that the host has to
authorise independently:

| Gate | What it gates | Where it lives |
|---|---|---|
| OS-level permission | The app can talk to the corresponding hardware (mic, camera, GPS) at all. | `AndroidManifest.xml` `<uses-permission>` |
| WebView delegation | The page (or an iframe inside it) can call `getUserMedia` / `getCurrentPosition` and get a real stream / fix back. | `WebChromeClient.onPermissionRequest` + `onGeolocationPermissionsShowPrompt` |

iOS only has the first one (the WKWebView wires the iframe call
through to the system prompt automatically once `Info.plist` has the
matching usage string). Android requires the host process to
explicitly forward iframe permission requests to the OS grant, which
is what the custom `WebChromeClient` does.

## Step-by-step

### 1. Generate the Android project

From `src-tauri/`:

```bash
yarn tauri android init
```

Commit the generated `src-tauri/gen/android/` skeleton. The
`MainActivity.kt`, `AndroidManifest.xml`, and `build.gradle.kts`
files are the ones we'll patch.

### 2. Manifest entries

Add the `<uses-permission>` lines that match what the app actually
uses. Keep this list in sync with the iframe `allow` tokens in
`AppIframeOverlay.tsx`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
```

`INTERNET` is normally added by `tauri android init` already - keep
it explicit so the diff is reviewable.

Also pin the activity to portrait, mirroring the iOS
`UISupportedInterfaceOrientations` lock in `Info.plist`:

```xml
<activity
    android:name=".MainActivity"
    android:screenOrientation="portrait"
    android:configChanges="orientation|screenSize|keyboardHidden">
```

### 3. CI patch for the manifest

The `tauri ios init` step in `.github/workflows/build-mobile.yml`
runs on every build, which would clobber any manually-committed
`AndroidManifest.xml` changes. The iOS jobs already work around this
with `plutil` patches after `tauri ios init` (`Patch Info.plist for
app permissions + Export Compliance`). Mirror that pattern with a
Python `xml.etree.ElementTree` patch that adds the four
`<uses-permission>` entries to the freshly-generated manifest. The
existing `Patch AndroidManifest (reachymini:// intent-filter for
AuthSessionActivity)` step is the right place to insert this - it
already runs in the right order.

### 4. Custom `WebChromeClient`

`MainActivity.kt`:

```kotlin
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.GeolocationPermissions

class ReachyMiniWebChromeClient : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest?) {
        // Grant whatever the iframe asked for; the OS-level grant
        // has already been negotiated via the runtime permission
        // launcher invoked from our host getUserMedia / vibrate /
        // geolocation calls. Without this override, wry's default
        // client denies the request silently.
        request?.grant(request.resources)
    }

    override fun onGeolocationPermissionsShowPrompt(
        origin: String?,
        callback: GeolocationPermissions.Callback?
    ) {
        callback?.invoke(origin, true, false)
    }
}
```

Wire it onto the WebView in `MainActivity.onCreate(...)`:

```kotlin
webView.webChromeClient = ReachyMiniWebChromeClient()
```

Tauri 2 exposes the underlying `WebView` via the `wry` plugin glue;
the exact accessor depends on the Tauri release on `Cargo.toml`. The
hook lives in `MainActivity.kt` rather than in Rust because
`WebChromeClient` is a JVM-side abstract class.

### 5. CI build job

The repo already has an `android` (debug APK) and `android-release`
(signed APK + AAB + Play upload) job in `build-mobile.yml`. They are
currently dormant because `tauri android init` was never run. Once
step 1 lands, the jobs should pass without further changes (NDK
setup, Rust targets, keystore secrets, and Play Developer API
upload are all already scripted).

Required secrets for the signed release job (already documented at
the top of `build-mobile.yml`):

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_PLAY_SERVICE_ACCOUNT_JSON`

## Smoke-test checklist

Once the runbook is executed, validate on a real device (Pixel-class
Android 12+ is the baseline):

1. **Host conversation**: tap a robot row → first prompt asks for
   microphone → grant → the orb reaches `connected`. Subsequent
   sessions don't re-prompt.
2. **Iframe mic Space**: open a voice Space from the Apps tab → the
   embed posts `embed:app-state` with `phase: 'live'` and audio
   capture works.
3. **Iframe camera Space**: open a vision Space → camera feed is
   visible in the iframe.
4. **Iframe geolocation Space**: open a location-aware Space → the
   iframe receives a fix from `navigator.geolocation`.
5. **Denial path**: deny the system prompt for one of the above →
   the corresponding Space surfaces its own "permission denied"
   error and the host doesn't crash.

## Cross-references

- iOS counterpart: usage strings in `src-tauri/Info.plist`, CI
  patches in `.github/workflows/build-mobile.yml`
  (`Patch Info.plist for app permissions + Export Compliance`).
- Iframe token list: `ui/panels/apps-list/AppIframeOverlay.tsx`
  (`allow="..."` on the iframe).
- Host mic unlock rationale:
  `features/conversation/permissions/iosMicUnlock.ts`.
- App Store / Play review checklist:
  `docs/APP_STORE_COMPLIANCE.md`.
