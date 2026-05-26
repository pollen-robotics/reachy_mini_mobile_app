#!/usr/bin/env bash
# take-store-screenshots.sh
# ─────────────────────────
# Interactive helper to capture App Store screenshots from a
# locally-installed iOS simulator build.
#
# Apple requires screenshots in specific resolutions per device
# class. This script targets the iPhone 6.9" / 6.7" class
# (iPhone 15 Pro Max @ 1290×2796), which is the *only* mandatory
# size at upload time - App Store Connect upsamples / re-uses
# it for the 6.5" and 5.5" slots when those are absent.
#
# Workflow
# ────────
#   1. Build the simulator .app locally:
#        yarn tauri ios build --target aarch64-sim --debug
#      (or grab the artefact from the latest CI run of the
#      `ios` job in `.github/workflows/build-mobile.yml`)
#   2. Run this script:
#        scripts/take-store-screenshots.sh
#      Optional: pass an explicit .app path as $1.
#   3. Navigate manually inside the simulator. Each time you
#      reach a screen worth shipping, hit <Enter> in this
#      terminal: the script saves a PNG under
#      `app-store-screenshots/iphone-69/NN.png`.
#   4. Ctrl-C when done. Upload the PNGs to App Store Connect
#      → My Apps → <app> → Distribution → iOS App → 6.9".
#
# Tips
# ────
#   - The simulator's status bar is fine as-is (Apple no longer
#     enforces "9:41 PM, full battery" - real status is accepted).
#   - If you DO want a clean status bar, run before each capture:
#       xcrun simctl status_bar "$UDID" override --time "9:41 PM" \
#         --cellularBars 4 --batteryLevel 100 --batteryState charged
#   - Marketing overlays (text in front of the UI) are now allowed
#     but discouraged for the first 3 screenshots: keep those raw.
#
# Resolution check
# ────────────────
# Each capture is verified against 1290×2796. If your simulator
# returns a different size (e.g. you used the wrong device class),
# the script prints a warning so you don't waste time uploading
# rejected screenshots.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Config ────────────────────────────────────────────────────
# Pro Max class iPhones (15+) all render at 1290×2796 which fits
# both the 6.7" and 6.9" App Store slots. We try the newest first;
# fallbacks let the script work on Xcode 15 (iPhone 15 PM) up to
# Xcode 26 (iPhone 17 PM).
DEVICE_NAME_CANDIDATES=(
  "iPhone 17 Pro Max"
  "iPhone 16 Pro Max"
  "iPhone 15 Pro Max"
)
# App Store Connect accepts either Pro Max resolution for the
# 6.9" slot: 1320×2868 (iPhone 16/17 PM, native @460ppi) and
# 1290×2796 (iPhone 15 PM, still valid fallback). We don't
# enforce a single dimension; we just verify the capture matches
# one of these so a wrong simulator doesn't waste the user's time.
VALID_RES_REGEX='^(1320x2868|2868x1320|1290x2796|2796x1290)$'
OUT_DIR="app-store-screenshots/iphone-69"
BUNDLE_ID=$(python3 -c "
import json, pathlib
print(json.loads(pathlib.Path('src-tauri/tauri.conf.json').read_text())['identifier'])
")

# ── Locate .app ───────────────────────────────────────────────
# Tauri's CLI drops the final sim bundle under
# `src-tauri/gen/apple/build/arm64-sim/Reachy Mini.app` (a copy
# of Xcode's DerivedData product). Fall back to the rust build
# tree when run before `tauri ios build` has finished.
APP_PATH="${1:-}"
if [[ -z "$APP_PATH" ]]; then
  CANDIDATES=(
    "src-tauri/gen/apple/build/arm64-sim"
    "src-tauri/target/aarch64-apple-ios-sim"
  )
  for dir in "${CANDIDATES[@]}"; do
    [[ -d "$dir" ]] || continue
    APP_PATH=$(
      find "$dir" -type d -name "*.app" \
        -not -path "*/Index.noindex/*" 2>/dev/null \
        | head -1
    )
    [[ -n "$APP_PATH" ]] && break
  done
fi
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  cat >&2 <<MSG
ERROR: no simulator .app found.

Build one locally with:
  yarn tauri ios build --target aarch64-sim --debug

Or pass an explicit path:
  $0 path/to/Reachy\\ Mini.app
MSG
  exit 1
fi
echo "Using app: $APP_PATH"
echo "Bundle id: $BUNDLE_ID"

# ── Resolve or create the simulator device ────────────────────
find_device() {
  local target_name="$1"
  xcrun simctl list devices -j | python3 - "$target_name" <<'PY'
import json, sys
name = sys.argv[1]
data = json.load(sys.stdin)
for runtime, devices in data['devices'].items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if d['name'] == name and d.get('isAvailable', False):
            print(d['udid'])
            sys.exit()
PY
}

UDID=""
DEVICE_NAME=""
for candidate in "${DEVICE_NAME_CANDIDATES[@]}"; do
  UDID=$(find_device "$candidate" || true)
  if [[ -n "$UDID" ]]; then
    DEVICE_NAME="$candidate"
    break
  fi
done

if [[ -z "$UDID" ]]; then
  # No existing device matched - create the first candidate
  # available in the runner's devicetype catalogue.
  for candidate in "${DEVICE_NAME_CANDIDATES[@]}"; do
    TYPE=$(xcrun simctl list devicetypes -j | python3 - "$candidate" <<'PY'
import json, sys
name = sys.argv[1]
data = json.load(sys.stdin)
for d in data['devicetypes']:
    if d['name'] == name:
        print(d['identifier'])
        sys.exit()
PY
)
    if [[ -n "$TYPE" ]]; then
      DEVICE_NAME="$candidate"
      break
    fi
  done
  if [[ -z "$TYPE" ]]; then
    echo "ERROR: none of the candidate Pro Max devices are installed in this Xcode." >&2
    echo "       Candidates: ${DEVICE_NAME_CANDIDATES[*]}" >&2
    exit 1
  fi
  echo "Creating $DEVICE_NAME simulator…"
  RUNTIME=$(xcrun simctl list runtimes -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
ios = sorted(
    r['identifier']
    for r in data['runtimes']
    if r.get('platform') == 'iOS' and r.get('isAvailable', False)
)
print(ios[-1])
")
  UDID=$(xcrun simctl create "$DEVICE_NAME" "$TYPE" "$RUNTIME")
fi
echo "Simulator: $DEVICE_NAME ($UDID)"

# ── Boot + open Simulator.app ─────────────────────────────────
echo "Booting simulator…"
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null

# ── Reinstall the app cleanly ─────────────────────────────────
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

mkdir -p "$OUT_DIR"

cat <<USAGE

════════════════════════════════════════════════════════════════
 Simulator ready. Navigate inside the iPhone window manually.
 Press <Enter> here to capture the current screen.
 Type 'q' then <Enter> (or Ctrl-C) when done.

 Output dir: $OUT_DIR/
 Expected resolution: 1320×2868 (or 1290×2796)
════════════════════════════════════════════════════════════════

USAGE

i=1
while true; do
  read -r -p "Enter to capture #$(printf '%02d' $i) (q to quit): " key
  case "$key" in
    q|Q) break ;;
  esac
  OUT="$OUT_DIR/$(printf '%02d' $i).png"
  # `simctl io` runs inside the Simulator's TCC sandbox and cannot
  # write into protected user folders (~/Documents, ~/Desktop). We
  # capture into /tmp then move into the project tree.
  TMP_PNG=$(mktemp -t store-screenshot-XXXXXX).png
  xcrun simctl io "$UDID" screenshot "$TMP_PNG"
  mv "$TMP_PNG" "$OUT"
  W=$(sips -g pixelWidth  "$OUT" | awk '/pixelWidth/  {print $2}')
  H=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/ {print $2}')
  if [[ ! "${W}x${H}" =~ $VALID_RES_REGEX ]]; then
    echo "  ⚠ $OUT is ${W}×${H} (expected 1320×2868 or 1290×2796)"
    echo "    App Store Connect may reject this size. Try a different device."
  else
    echo "  ✓ Saved $OUT (${W}×${H})"
  fi
  i=$((i + 1))
done

echo
echo "Done. ${OUT_DIR}/ contains $((i - 1)) screenshot(s)."
echo "Next: open https://appstoreconnect.apple.com → Apps → your app"
echo "      → Distribution → iOS App → 6.9\" and drag-drop the PNGs."
