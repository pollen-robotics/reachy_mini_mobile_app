//! A cross platform BLE client.
//!
//! On Linux, macOS, Windows and iOS this is a thin layer over
//! [btleplug](https://github.com/deviceplug/btleplug); on Android it uses its
//! own backend. [`Handler`] is the entry point: initialize it once with
//! [`init`], then reach it from anywhere with [`get_handler`].
//!
//! ```no_run
//! # async fn example() -> Result<(), blec::Error> {
//! let handler = blec::init().await?;
//! # Ok(())
//! # }
//! ```
//!
//! For a Tauri app use the `tauri-plugin-blec` crate instead, which wraps this
//! one in a plugin with a JavaScript API.

use std::sync::atomic::AtomicBool;

use once_cell::sync::OnceCell;

#[cfg(target_os = "android")]
pub mod android;
mod error;
mod handler;
#[cfg(any(test, feature = "mock"))]
pub mod mock;
pub mod models;

pub use error::{Error, Result};
pub use handler::Handler;
pub use handler::{OnDisconnectHandler, SubscriptionHandler};
pub use models::{Timeouts, TimeoutsMs};

/// Whether scans and permission requests include iBeacon devices, which on
/// Android additionally requires the location permission.
pub static ALLOW_IBEACONS: AtomicBool = AtomicBool::new(false);

static HANDLER: OnceCell<Handler> = OnceCell::new();

/// Initializes the BLE handler.
///
/// Calling this more than once is allowed and returns the handler created by
/// the first call.
///
/// # Errors
/// Returns an error if the platform backend cannot be set up.
pub async fn init() -> Result<&'static Handler> {
    if let Some(handler) = HANDLER.get() {
        return Ok(handler);
    }
    let handler = Handler::new().await?;
    let _ = HANDLER.set(handler);
    get_handler()
}

/// Returns the BLE handler.
///
/// # Errors
/// Returns an error if [`init`] has not been called yet.
pub fn get_handler() -> Result<&'static Handler> {
    let handler = HANDLER.get().ok_or(Error::HandlerNotInitialized)?;
    Ok(handler)
}

/// Checks if the app has the necessary permissions to use BLE.
/// If `ask_if_denied` is true, the user will be prompted again to grant permissions if they
/// previously denied.
///
/// Always true off Android, which is the only platform with runtime BLE permissions.
///
/// # Errors
/// Returns an error if the permission check itself fails.
#[allow(unused)]
pub async fn check_permissions(ask_if_denied: bool) -> Result<bool> {
    #[cfg(target_os = "android")]
    return android::check_permissions(ask_if_denied).await;
    #[cfg(not(target_os = "android"))]
    return Ok(true);
}

/// Forgets the phone's bond with the device at `address`, for a bond the
/// device no longer has the keys for: every connect then fails with
/// `GATT_INSUFFICIENT_AUTHENTICATION` until the bond is gone.
///
/// Returns true once the device is not bonded anymore (including when it never
/// was). Only Android lets an app do this; elsewhere it returns false.
///
/// # Errors
/// Returns an error if the call to the platform fails.
#[allow(unused)]
pub async fn remove_bond(address: &str) -> Result<bool> {
    #[cfg(target_os = "android")]
    return android::remove_bond(address).await;
    #[cfg(not(target_os = "android"))]
    return Ok(false);
}

/// Opens the system Bluetooth settings, where the user can forget a device.
///
/// Returns false where an app can't open them (anywhere but Android).
///
/// # Errors
/// Returns an error if the call to the platform fails.
#[allow(unused)]
pub async fn open_bluetooth_settings() -> Result<bool> {
    #[cfg(target_os = "android")]
    return android::open_bluetooth_settings().await;
    #[cfg(not(target_os = "android"))]
    return Ok(false);
}
