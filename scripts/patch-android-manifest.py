#!/usr/bin/env python3
"""Patch the generated Android manifest the same way CI does.

`tauri android init` regenerates `src-tauri/gen/android/.../AndroidManifest.xml`
without the app-specific bits the build needs. CI's build-mobile.yml applies
these patches between `init` and `build`; local builds must do the same or HF
sign-in dead-ends on the "Returning to Reachy Mini" screen (the reachymini://
OAuth callback has no Android handler).

Run this after `tauri android init` / before `tauri android build`. Idempotent.
Mirrors the two "Patch AndroidManifest ..." steps in
.github/workflows/build-mobile.yml.
"""
import pathlib
import re
import sys

p = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
s = p.read_text()

# --- Patch 1: app permissions + portrait lock + strip blec GPS perms ---
if "xmlns:tools" not in s:
    s2 = re.sub(
        r'(<manifest\s+xmlns:android="[^"]+")',
        r'\1\n          xmlns:tools="http://schemas.android.com/tools"',
        s, count=1,
    )
    if s2 == s:
        print("::error::<manifest> root not found.", file=sys.stderr); sys.exit(1)
    s = s2

if "screenOrientation" not in s:
    s2 = re.sub(
        r'(android:name="[^"]*MainActivity")',
        r'\1\n            android:screenOrientation="portrait"',
        s, count=1,
    )
    if s2 == s:
        print("::warning::MainActivity activity not matched for screenOrientation.", file=sys.stderr)
    else:
        print("Locked MainActivity to portrait.")
    s = s2

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
        print("::error::<!-- AndroidTV support --> anchor not found.", file=sys.stderr); sys.exit(1)
    s = s2
    print("Injected app permissions + location-strip overrides.")
else:
    print("Permissions already present, skipping.")

# --- Patch 2: reachymini:// intent-filter for AuthSessionActivity ---
if 'android:scheme="reachymini"' in s:
    print("reachymini:// intent-filter already present, skipping.")
else:
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
    s3 = s.replace("</application>", snippet, 1)
    if s3 == s:
        print("::error::</application> anchor not found in manifest.", file=sys.stderr); sys.exit(1)
    s = s3
    print("Injected reachymini:// intent-filter on AuthSessionActivity.")

p.write_text(s)
