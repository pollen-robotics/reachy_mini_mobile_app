fn main() {
    // iOS-specific: `tauri-plugin-blec`'s upstream README expects
    // contributors to add CoreBluetooth.framework manually via the
    // Xcode UI. That works for local dev but doesn't survive
    // `tauri ios init` regeneration in CI (where the runner's older
    // Xcode rebuilds a clean project that doesn't know about our
    // manual additions).
    //
    // Linking the framework here at the Cargo layer means the
    // dependency travels with the binary regardless of how the
    // Xcode project was generated. The directive is a no-op on
    // every other platform and shouldn't be set unconditionally
    // because CoreBluetooth is iOS/macOS-only.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "ios" {
        println!("cargo:rustc-link-lib=framework=CoreBluetooth");
    }

    tauri_build::build()
}
