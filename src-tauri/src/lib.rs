//! Reachy Mini mobile client (iOS + Android, desktop-ready).
//!
//! The Rust side stays deliberately thin:
//!
//!   * `daemon_fetch` - proxies an HTTP request to the robot daemon,
//!     side-stepping the mixed-content block that mobile WebViews apply
//!     to plain `http://` calls from `https://tauri.localhost`.
//!   * `local_ips` - returns the device's IPv4 addresses so the UI can
//!     check whether the phone and the robot share a /24 subnet.
//!
//! Everything else (daemon lifecycle, USB, permissions, updates, code
//! signing) lives elsewhere: this repo deliberately assumes the daemon is
//! already running on a Reachy Mini somewhere nearby, reachable via the
//! HF central signaling Space.

mod commands;
mod oauth;

use tauri::Manager;
use tracing::info;

/// Tauri entrypoint, shared between the binary target (`main.rs`) and the
/// mobile static lib target.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a tracing subscriber so our `info!/warn!/debug!` events
    // actually end up on stderr. `RUST_LOG` overrides the default filter
    // for targeted investigation. Safe to call multiple times during
    // dev HMR: we swallow the error if a subscriber is already registered.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .with_line_number(false)
        .try_init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        // In-app OAuth via ASWebAuthenticationSession (iOS/macOS) and
        // Chrome Custom Tabs (Android). Replaces the old "open Safari +
        // wait on loopback" flow that Apple App Review now rejects.
        // See `oauth.rs` for the loopback bridge that ferries HF's
        // localhost callback to the `reachymini://` scheme this plugin
        // intercepts.
        .plugin(tauri_plugin_auth_session::init())
        // Keep-screen-on: disables the OS idle timer while the JS
        // layer requests it (active conversation or open iframe app).
        // No-op on desktop; the JS wrapper falls back to the Web
        // Wake Lock API for the macOS / Linux preview builds.
        .plugin(tauri_plugin_keep_screen_on::init())
        // BLE central for WiFi provisioning (scan/connect/notify against the
        // robot's GATT command service). Handles the Android BLE runtime +
        // permission plumbing; the JS side lives in `features/ble/bleWifi.ts`.
        .plugin(tauri_plugin_blec::init())
        // Native share sheet + filesystem. Together they back the
        // Android save/share bridge for embedded apps: the embed posts
        // file bytes, we write them to the app cache (`fs`) and open the
        // OS share sheet on that path (`sharekit`). See the `save-file`
        // listener in `AppIframeOverlay.tsx`.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sharekit::init())
        .setup(|app| {
            info!("reachy_mini_mobile_app starting");
            // In debug builds, auto-open the WebView devtools so the
            // developer doesn't have to dig through Safari's `Develop`
            // menu to inspect the page. The `devtools` Cargo feature
            // (in `Cargo.toml`) gates the runtime API itself; we
            // additionally guard with `debug_assertions` so a release
            // build never pops the inspector even if someone enabled
            // the feature for some reason.
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            // Silence the unused-import warning when the cfg is off.
            #[cfg(not(debug_assertions))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::daemon_fetch,
            commands::local_ips,
            oauth::start_oauth_bridge,
            oauth::cancel_oauth_bridge,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
