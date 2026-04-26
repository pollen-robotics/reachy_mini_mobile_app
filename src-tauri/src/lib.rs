//! Reachy Mini mobile client (iOS + Android, desktop-ready).
//!
//! The Rust side stays deliberately thin:
//!
//!   * BLE is delegated to `tauri-plugin-blec`. Scan, connect, read and
//!     write are all driven from the TypeScript side (see
//!     `src/ble/useBleSession.ts`). That mirrors the desktop app's
//!     architecture exactly and lets us share one persistent BLE
//!     connection per user session, which is the pattern macOS
//!     CoreBluetooth is happiest with.
//!   * `daemon_fetch` - proxies an HTTP request to the robot daemon,
//!     side-stepping the mixed-content block that mobile WebViews apply
//!     to plain `http://` calls from `https://tauri.localhost`.
//!   * `local_ips` - returns the device's IPv4 addresses so the UI can
//!     check whether the phone and the robot share a /24 subnet.
//!
//! Everything else (daemon lifecycle, USB, permissions, updates, code
//! signing) lives elsewhere: this repo deliberately assumes the daemon is
//! already running on a Reachy Mini somewhere nearby.

mod commands;
mod oauth;

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
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,btleplug=warn")),
        )
        .with_target(true)
        .with_line_number(false)
        .try_init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        // BLE: the plugin init panics when Bluetooth is unavailable on
        // the host (no adapter in some macOS headless setups). Catch
        // the panic so the app still boots in daemon-less dev modes,
        // matching what the desktop app does.
        .plugin(match std::panic::catch_unwind(tauri_plugin_blec::init) {
            Ok(plugin) => plugin,
            Err(_) => {
                tracing::warn!(
                    "tauri-plugin-blec init panicked; BLE features will be disabled"
                );
                tauri_plugin_blec::init()
            }
        })
        .setup(|_app| {
            info!("reachy_mini_mobile_app starting");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::daemon_fetch,
            commands::local_ips,
            oauth::start_oauth_callback,
            oauth::cancel_oauth_callback,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
