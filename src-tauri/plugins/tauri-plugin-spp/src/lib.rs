//! Bluetooth Classic serial port (SPP) for Android.
//!
//! The Reachy Mini wheeled base (ESP32 `rmini_wheels`) speaks a line protocol
//! over Bluetooth Classic SPP, which the BLE plugin can't reach. All the work
//! lives in `android/.../SppPlugin.kt`; JS calls it as `plugin:spp|<command>`.
//! No-op on other platforms.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("spp")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.pollen_robotics.spp", "SppPlugin")?;
            Ok(())
        })
        .build()
}
