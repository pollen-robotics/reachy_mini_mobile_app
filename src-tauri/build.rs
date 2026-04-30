//! Build script.
//!
//! On Android we patch the generated `AndroidManifest.xml` to declare the
//! permissions our app actually needs at runtime. The block is identified
//! by `reachy-mini-permissions` so re-runs are idempotent (we strip the
//! previous block before inserting the new one).
//!
//! Permissions covered:
//!   - INTERNET / ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE: outbound
//!     HTTPS to HF central + OpenAI Realtime, plus the local-IP probe
//!     used by `useLocalIps` to decide if the phone shares a /24 with
//!     the robot.
//!   - RECORD_AUDIO / MODIFY_AUDIO_SETTINGS: required for WebRTC. wry's
//!     `RustWebChromeClient.onPermissionRequest` triggers the system
//!     prompt automatically when `getUserMedia({audio:true})` is called,
//!     but only if both permissions are declared in the manifest.
//!   - BLUETOOTH_SCAN / BLUETOOTH_CONNECT (Android 12+): tauri-plugin-blec
//!     requests these at runtime in `BleClient.checkPermissions()`.
//!   - BLUETOOTH / BLUETOOTH_ADMIN / ACCESS_FINE_LOCATION: rétro-compat
//!     Android <12. Capped via `android:maxSdkVersion="30"`.
//!
//! On non-Android targets the patch is a no-op (the
//! `TAURI_ANDROID_PROJECT_PATH` env var is unset by tauri-cli), so this
//! code path is transparent to desktop and iOS builds.
//!
//! Implementation note
//! ───────────────────
//! `tauri_build::mobile::update_android_manifest` is NOT part of the
//! public API of `tauri-build 2.5.x` (the `mobile` module is private).
//! We therefore patch the manifest ourselves via `std::fs`. The logic is
//! intentionally minimal: locate the marker block, strip it, re-insert
//! before `</manifest>`. This is robust to repeated `cargo build` runs
//! and to changes in the surrounding manifest content emitted by tauri.

use std::env;
use std::fs;
use std::path::PathBuf;

/// Marker used to delimit the block we manage. Anything between
/// `<!-- BEGIN $MARKER -->` and `<!-- END $MARKER -->` is owned by this
/// build script and may be rewritten on every build.
const MARKER: &str = "reachy-mini-permissions";

const ANDROID_PERMISSIONS: &str = r#"<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />

<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<uses-permission android:name="android.permission.BLUETOOTH"
                 android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN"
                 android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
                 android:maxSdkVersion="30" />

<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
<uses-feature android:name="android.hardware.microphone" android:required="false" />
<uses-feature android:name="android.hardware.wifi" android:required="false" />"#;

fn main() {
    if let Err(err) = patch_android_manifest_if_present() {
        // Fail loudly so a broken manifest path can't ship silently. On
        // desktop/iOS we never enter the helper because
        // `TAURI_ANDROID_PROJECT_PATH` is unset, so this branch is
        // Android-CI only.
        panic!("failed to patch AndroidManifest.xml: {err}");
    }

    tauri_build::build()
}

fn patch_android_manifest_if_present() -> Result<(), String> {
    let Ok(android_project) = env::var("TAURI_ANDROID_PROJECT_PATH") else {
        // Desktop / iOS build: nothing to patch.
        return Ok(());
    };

    let manifest_path: PathBuf = PathBuf::from(android_project)
        .join("app")
        .join("src")
        .join("main")
        .join("AndroidManifest.xml");

    if !manifest_path.exists() {
        // tauri-cli regenerates the Android project on demand. If the
        // manifest isn't there yet, skip silently — the next run after
        // `tauri android init` will patch it.
        return Ok(());
    }

    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let original = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;

    let stripped = strip_managed_block(&original);
    let injected = inject_permissions_block(&stripped, ANDROID_PERMISSIONS)?;

    if injected != original {
        fs::write(&manifest_path, injected)
            .map_err(|e| format!("write {}: {e}", manifest_path.display()))?;
    }

    Ok(())
}

/// Remove any previous `<!-- BEGIN $MARKER --> ... <!-- END $MARKER -->`
/// block from the input. Idempotent: if no marker block is present, the
/// input is returned unchanged.
fn strip_managed_block(input: &str) -> String {
    let begin_tag = format!("<!-- BEGIN {MARKER} -->");
    let end_tag = format!("<!-- END {MARKER} -->");

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(begin_rel) = input[cursor..].find(&begin_tag) {
        let begin = cursor + begin_rel;
        out.push_str(&input[cursor..begin]);

        let after_begin = begin + begin_tag.len();
        let Some(end_rel) = input[after_begin..].find(&end_tag) else {
            // No closing tag: keep what we have so far and bail. The
            // user can re-init the Android project to recover.
            out.push_str(&input[begin..]);
            return out;
        };
        let end = after_begin + end_rel + end_tag.len();
        cursor = end;

        // Trim a single trailing newline left over from the stripped
        // block so we don't accumulate blank lines on every rerun.
        if input[cursor..].starts_with('\n') {
            cursor += 1;
        }
    }
    out.push_str(&input[cursor..]);
    out
}

/// Insert the managed block before the closing `</manifest>` tag.
fn inject_permissions_block(input: &str, body: &str) -> Result<String, String> {
    let close_idx = input
        .rfind("</manifest>")
        .ok_or_else(|| "missing </manifest> closing tag".to_string())?;

    let begin_tag = format!("<!-- BEGIN {MARKER} -->");
    let end_tag = format!("<!-- END {MARKER} -->");

    let mut out = String::with_capacity(input.len() + body.len() + 64);
    out.push_str(&input[..close_idx]);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&begin_tag);
    out.push('\n');
    out.push_str(body);
    out.push('\n');
    out.push_str(&end_tag);
    out.push('\n');
    out.push_str(&input[close_idx..]);
    Ok(out)
}
