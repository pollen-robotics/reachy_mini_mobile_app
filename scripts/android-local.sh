#!/usr/bin/env bash
# Local Android dev loop: regenerate + patch src-tauri/gen/android the same
# way CI does (.github/workflows/build-mobile.yml, `android` job), then build
# a debug APK and/or install it on the USB-connected phone.
#
#   scripts/android-local.sh build     # init/patch if needed, debug APK
#   scripts/android-local.sh install   # adb install -r the last APK, launch it
#   scripts/android-local.sh run       # build + install
#   scripts/android-local.sh dev       # hot-reload: tauri android dev on the phone
#   scripts/android-local.sh logs      # WebView console + Rust logs from the phone
#
# The dev build uses its own applicationId (`<id>.dev`, label "Reachy Mini
# Dev") so it installs next to the store / CI build instead of clashing with
# its signing key. Set ANDROID_DEV_APP_ID_SUFFIX= to drop the suffix.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
: "${NDK_HOME:=$ANDROID_HOME/ndk/27.0.12077973}"
export JAVA_HOME ANDROID_HOME NDK_HOME ANDROID_SDK_ROOT="$ANDROID_HOME" ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
SUFFIX="${ANDROID_DEV_APP_ID_SUFFIX-.dev}"
GEN=src-tauri/gen/android

init_and_patch() {
  if [ ! -d "$GEN" ]; then
    yarn tauri android init --skip-targets-install
    yarn tauri icon src/assets/reachy-app-icon.png || true
    git checkout -- src-tauri/icons  # tauri icon also rewrites the tracked desktop icons
    for d in mipmap-mdpi mipmap-hdpi mipmap-xhdpi mipmap-xxhdpi mipmap-xxxhdpi; do
      src="src-tauri/icons/android/$d/ic_launcher_foreground.png"
      dst="$GEN/app/src/main/res/$d/ic_launcher_foreground.png"
      [ -f "$src" ] && [ -d "$(dirname "$dst")" ] && cp -f "$src" "$dst"
    done
  fi
  python3 scripts/patch-android-insets.py
  SUFFIX="$SUFFIX" python3 - <<'PY'
import os, pathlib, re, sys

gradle = pathlib.Path("src-tauri/gen/android/app/build.gradle.kts")
s = gradle.read_text()
s = re.sub(r'minSdk\s*=\s*\d+', 'minSdk = 26', s, count=1)
suffix = os.environ.get("SUFFIX", "")
if suffix and "applicationIdSuffix" not in s:
    s, n = re.subn(r'(getByName\("debug"\)\s*\{)', r'\1\n            applicationIdSuffix = "%s"\n            resValue("string", "app_name", "Reachy Mini Dev")' % suffix, s, count=1)
    if n == 0:
        sys.exit("debug buildType not found in build.gradle.kts")
gradle.write_text(s)

# The generated strings.xml declares app_name; the debug resValue above would
# clash with it, so move the default into the release build type instead.
strings = pathlib.Path("src-tauri/gen/android/app/src/main/res/values/strings.xml")
if suffix and strings.exists():
    t = strings.read_text()
    t2 = re.sub(r'\s*<string name="app_name">[^<]*</string>', '', t)
    if t2 != t:
        strings.write_text(t2)
        s = gradle.read_text()
        s = re.sub(r'(getByName\("release"\)\s*\{)', r'\1\n            resValue("string", "app_name", "Reachy Mini")', s, count=1)
        gradle.write_text(s)

m = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
s = m.read_text()
if "xmlns:tools" not in s:
    s = re.sub(r'(<manifest\s+xmlns:android="[^"]+")',
               r'\1\n          xmlns:tools="http://schemas.android.com/tools"', s, count=1)
if "screenOrientation" not in s:
    s = re.sub(r'(android:name="[^"]*MainActivity")',
               r'\1\n            android:screenOrientation="portrait"', s, count=1)
if "RECORD_AUDIO" not in s:
    perms = (
        '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
        '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n'
        '    <uses-permission android:name="android.permission.CAMERA" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" tools:node="remove" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" tools:node="remove" />\n\n'
        '    <!-- AndroidTV support -->'
    )
    s2 = s.replace('    <!-- AndroidTV support -->', perms, 1)
    if s2 == s:
        sys.exit("<!-- AndroidTV support --> anchor not found in manifest")
    s = s2
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
m.write_text(s)
print("gen/android patched")
PY
}

apk_path() {
  find "$GEN/app/build/outputs/apk" -name '*.apk' -type f -print0 2>/dev/null | xargs -0 ls -t | head -1
}

app_id() {
  echo "$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["identifier"].replace("-","_"))')$SUFFIX"
}

cmd_build() {
  init_and_patch
  # Only the phone's ABI: 4x faster than the CI's all-targets build.
  yarn tauri android build --debug --apk --target aarch64
  echo "APK: $(apk_path)"
}

cmd_install() {
  local apk; apk="$(apk_path)"
  [ -n "$apk" ] || { echo "no APK, run build first" >&2; exit 1; }
  adb install -r "$apk"
  adb shell monkey -p "$(app_id)" -c android.intent.category.LAUNCHER 1 >/dev/null
  echo "installed + launched $(app_id)"
}

case "${1:-run}" in
  build) cmd_build ;;
  install) cmd_install ;;
  run) cmd_build; cmd_install ;;
  dev) init_and_patch; yarn tauri android dev ;;
  logs) adb logcat -v time 'chromium:V' 'Tauri/Console:V' 'RustStdoutStderr:V' '*:S' ;;
  patch) init_and_patch ;;
  *) echo "usage: $0 build|install|run|dev|logs|patch" >&2; exit 2 ;;
esac
