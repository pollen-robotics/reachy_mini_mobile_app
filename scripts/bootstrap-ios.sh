#!/usr/bin/env bash
# Bootstrap script for iOS development on this machine.
#
# Run AFTER Xcode has been installed from the Mac App Store. It does the
# steps that don't need a GUI: switch xcode-select to the full Xcode,
# accept the license, run the first-launch installers, and install
# CocoaPods dependencies inside `src-tauri/gen/apple/`.
#
# What it does NOT do (you have to do these manually in Xcode the first
# time, see docs/IOS_SETUP.md):
#   - Select your Apple Developer Team
#   - Optionally change the bundle identifier from `com.tfrere.reachymini.app`
#     in tauri.conf.json + gen/apple/project.yml + .xcodeproj/project.pbxproj
#     if you fork this repo
#   - Pair your iPhone (USB) and trust the Mac
#   - Enable iOS Developer Mode on the iPhone
#
# Usage:
#   ./scripts/bootstrap-ios.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
XCODE_APP="/Applications/Xcode.app"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
err()  { printf "\033[31mx\033[0m %s\n" "$*" 1>&2; }

bold "[1/6] Checking Xcode installation"
if [[ ! -d "$XCODE_APP" ]]; then
  err "Xcode.app not found at $XCODE_APP."
  err "Install Xcode from the Mac App Store first, then re-run this script."
  exit 1
fi
ok "Xcode found at $XCODE_APP"

bold "[2/6] Pointing xcode-select at Xcode (sudo)"
CURRENT_DEVDIR="$(xcode-select -p 2>/dev/null || echo none)"
EXPECTED_DEVDIR="$XCODE_APP/Contents/Developer"
if [[ "$CURRENT_DEVDIR" == "$EXPECTED_DEVDIR" ]]; then
  ok "xcode-select already points at Xcode"
else
  warn "xcode-select currently points at: $CURRENT_DEVDIR"
  sudo xcode-select -s "$EXPECTED_DEVDIR"
  ok "xcode-select switched to $EXPECTED_DEVDIR"
fi

bold "[3/6] Accepting Xcode license (sudo)"
if sudo xcodebuild -license check >/dev/null 2>&1; then
  ok "License already accepted"
else
  sudo xcodebuild -license accept
  ok "License accepted"
fi

bold "[4/6] Running Xcode first-launch installers (sudo)"
sudo xcodebuild -runFirstLaunch
ok "First-launch installers done"

bold "[5/6] Verifying iOS toolchain"
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
rustup target list --installed | grep -E "(aarch64-apple-ios|aarch64-apple-ios-sim|x86_64-apple-ios)" || {
  err "Missing Rust iOS targets. Installing now..."
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
}
ok "Toolchain ready"

bold "[6/6] Installing CocoaPods deps in src-tauri/gen/apple/"
APPLE_DIR="$PROJECT_ROOT/src-tauri/gen/apple"
if [[ ! -d "$APPLE_DIR" ]]; then
  err "Missing $APPLE_DIR. Run 'yarn tauri ios init' first."
  exit 1
fi
(
  cd "$APPLE_DIR"
  if command -v pod >/dev/null 2>&1; then
    pod install
    ok "CocoaPods deps installed"
  else
    warn "CocoaPods not installed. Skipping (only needed if any plugin pulls Pods)."
  fi
)

cat <<EOF

$(bold "Bootstrap complete.")

Next steps (manual, in Xcode - see docs/IOS_SETUP.md for the full runbook):

  1. Open the workspace:
       open src-tauri/gen/apple/reachy_mini_mobile_app.xcodeproj

  2. Select the target 'reachy_mini_mobile_app_iOS' -> Signing & Capabilities:
       - Check "Automatically manage signing"
       - Pick your Team (your free Apple ID works; sign in via Xcode > Settings > Accounts first)
       - Bundle identifier is com.tfrere.reachymini.app (set in tauri.conf.json + project.yml + project.pbxproj)

  3. Plug in your iPhone with USB-C/Lightning. On the phone:
       - Tap "Trust This Computer"
       - Settings > Privacy & Security > Developer Mode > ON, then reboot

  4. Pick your iPhone in the Xcode device dropdown, then either:
       - Press the Run button in Xcode, or
       - From the project root: yarn tauri ios dev --open

  5. Once the app is installed once, you can switch to Wi-Fi debugging:
       Window > Devices and Simulators > tick "Connect via network"
EOF
