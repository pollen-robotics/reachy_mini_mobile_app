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
    // Desktop only: install a tracing subscriber so our `info!/warn!/debug!`
    // events end up on stderr. On mobile this fights with `tauri-plugin-log`
    // (both try to install the global `log::` logger), so we leave logging
    // entirely to the plugin there. Safe to call multiple times during dev
    // HMR: we swallow the error if a subscriber is already registered.
    #[cfg(not(mobile))]
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,btleplug=warn")),
        )
        .with_target(true)
        .with_line_number(false)
        .try_init();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Mobile only: forward JS `console.*` to Rust `tracing` via
    // `tauri-plugin-log`. iOS bit-buckets app stdout and Safari Web
    // Inspector is unreliable on Tauri (tauri-apps/tauri#13346), so we
    // also write to `{appHome}/Library/Logs/{bundleId}/`. We pull the
    // file off the iPhone with
    //   `xcrun devicectl device copy from --domain-type appDataContainer
    //    --domain-identifier com.tfrere.reachymini.app
    //    --source Library/Logs/com.tfrere.reachymini.app/<file>`.
    //
    // On desktop the plugin would fight `tracing_subscriber::fmt()`
    // above (both call `log::set_logger`, second one panics) and we
    // don't need it anyway: the host terminal already shows stderr.
    // The JS side calls (`logInfo`, `logError`, ...) gracefully fall
    // back to plain `console.*` thanks to the `.catch()` in
    // `src/main.tsx`.
    #[cfg(mobile)]
    {
        builder = builder.plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("reachy_mini".to_string()),
                    }),
                ])
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        );
    }

    let builder = builder
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
