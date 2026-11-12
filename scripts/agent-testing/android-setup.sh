#!/usr/bin/env bash
# Regenerate and patch the Android scaffold for a local build, the way CI
# does it (.github/workflows/build-mobile.yml): src-tauri/gen/android is
# not tracked, and Tauri rejects the committed RGB icons. Idempotent; run it
# from anywhere before the first `yarn tauri android build` of a session.
#
# Leaves the RGBA-resaved icons modified in the working tree: revert them
# after the build with `git checkout -- src-tauri/icons`.
#
# Env: ANDROID_HOME (default ~/Android/Sdk), NDK_HOME (default: newest NDK
# under $ANDROID_HOME/ndk).
set -euo pipefail
cd "$(dirname "$0")/../.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# 1. Force-resave all PNG icons to RGBA (Tauri rejects committed RGB icons).
python3 - <<'PY'
from PIL import Image; import pathlib
for p in pathlib.Path('src-tauri/icons').rglob('*.png'):
    Image.open(p).convert('RGBA').save(p, 'PNG')
PY

# 2. (Re-)init the Android scaffold.
rm -rf src-tauri/gen/android
yarn tauri android init

# 3. Bump minSdk 24 → 26 (tauri-plugin-blec requirement, otherwise gradle merge fails).
sed -i 's/minSdk = 24/minSdk = 26/' src-tauri/gen/android/app/build.gradle.kts

# 4. Patch AndroidManifest:
#    a. App permissions for iframe HF Spaces (mic/camera/location/BLE).
#    b. reachymini:// intent-filter for AuthSessionActivity (OAuth callback;
#       without it, Chrome Custom Tabs has no handler, and HF sign-in dies
#       with "user_cancelled"). This is the same patch CI applies at
#       build-mobile.yml:516-578.
python3 - <<'PY'
import pathlib, re, sys
p = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
s = p.read_text()

# Lock to portrait (Android rotation block; mirrors iOS
# UISupportedInterfaceOrientations=Portrait). The layout assumes a
# tall ~420px column; landscape breaks the orb + safe-area math.
if "screenOrientation" not in s:
    s = re.sub(r'(android:name="[^"]*MainActivity")',
               r'\1\n            android:screenOrientation="portrait"', s, count=1)

# Permissions
if "RECORD_AUDIO" not in s:
    # Mic + camera only: location was intentionally removed (2026-06)
    # ahead of the next Android/iOS store validation pass — no Space
    # surfaces a geolocation feature today and the extra permission
    # was an App Review red flag for a capability we don't use.
    #
    # `tauri-plugin-blec` 0.8.1 transitively declares
    # ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION in its own AAR
    # (BLE scanning needed location on Android 6-11). Without an
    # override, those leak into our merged manifest and the Play
    # Store listing shows "Location" — so we strip them via
    # tools:node="remove". The cost: BLE WiFi provisioning won't
    # work on Android 8-11. Android 12+ is unaffected because blec
    # also declares BLUETOOTH_SCAN with neverForLocation.
    perms = (
        '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
        '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n'
        '    <uses-permission android:name="android.permission.CAMERA" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" tools:node="remove" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" tools:node="remove" />\n\n'
        '    <!-- AndroidTV support -->'
    )
    s = s.replace('    <!-- AndroidTV support -->', perms, 1)

# xmlns:tools on <manifest>
if "xmlns:tools" not in s:
    s = re.sub(
        r'(<manifest\s+xmlns:android="[^"]+")',
        r'\1\n          xmlns:tools="http://schemas.android.com/tools"',
        s, count=1,
    )

# OAuth callback intent filter
if 'android:scheme="reachymini"' not in s:
    snippet = (
        '    <activity\n'
        '            android:name="app.tauri.auth_session.AuthSessionActivity"\n'
        '            android:exported="true"\n'
        '            tools:node="merge">\n'
        '            <intent-filter>\n'
        '                <action android:name="android.intent.action.VIEW" />\n'
        '                <category android:name="android.intent.category.DEFAULT" />\n'
        '                <category android:name="android.intent.category.BROWSABLE" />\n'
        '                <data android:scheme="reachymini" />\n'
        '            </intent-filter>\n'
        '        </activity>\n'
        '    </application>'
    )
    s = s.replace("</application>", snippet, 1)

p.write_text(s)
PY

# 5. Patch MainActivity.kt with the safe-area inset bridge (the same
#    tracked script CI runs in both jobs).
python3 scripts/patch-android-insets.py

echo "Android scaffold ready. Build: yarn tauri android build --apk --target aarch64"
