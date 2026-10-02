// Kotlin implements these (android/); the Rust side only registers the
// class, and Tauri forwards each command to it. Listing them here generates
// the `allow-*` permissions the capability file grants.
const COMMANDS: &[&str] = &["listen", "bonded", "scan", "connect", "write", "disconnect"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
