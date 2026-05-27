#!/usr/bin/env bash
# take-store-screenshots.sh
# ─────────────────────────
# Interactive helper to capture App Store screenshots from a
# locally-installed iOS simulator build.
#
# Apple requires screenshots in specific resolutions per device
# class. App Store Connect's review queue for this app only
# accepts the 6.7" slot (1284×2778) or the 6.5" slot (1242×2688),
# NOT the newer 6.9" slot - uploading 1290×2796 triggers a hard
# validation rejection ("le screenshot doit être 1242 × 2688,
# 2688 × 1242, 1284 × 2778 ou 2778 × 1284").
#
# We target the iPhone 14 Pro Max (6.7" / 1284×2778) by default
# because ASC auto-fills the 6.5" slot from a 6.7" upload, so one
# batch covers both display classes.
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
#      `app-store-screenshots/iphone-67/NN.png`.
#   4. Ctrl-C when done. Upload the PNGs to App Store Connect
#      → My Apps → <app> → Distribution → iOS App → 6.7".
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
#   - When WebRTC fails in the simulator (mDNS host candidates
#     don't resolve over the LAN), fall back to `capture-mac.sh`
#     which shoots from the Tauri desktop dev window instead. Both
#     scripts write into the same `app-store-screenshots/iphone-67/`
#     folder so screenshots can be mixed freely.
#
# Resolution check
# ────────────────
# Each capture is verified against 1284×2778 (or 1242×2688). If
# the simulator returns a different size (e.g. an iPhone 15+ Pro
# Max was booted, which produces 1290×2796 or 1320×2868), the
# script prints a warning so the user doesn't waste time uploading
# rejected screenshots.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Config ────────────────────────────────────────────────────
# iPhone 14 Pro Max (and the identically-sized 13/12 Pro Max)
# render at 1284×2778 - exactly what ASC's 6.7" slot wants.
# iPhone XS Max / 11 Pro Max render at 1242×2688 (6.5" slot) and
# also work; ASC will then host them in the 6.5" slot. We try
# Pro Max first; older devices remain as a last-ditch fallback.
DEVICE_NAME_CANDIDATES=(
  "iPhone 14 Pro Max"
  "iPhone 13 Pro Max"
  "iPhone 12 Pro Max"
  "iPhone 11 Pro Max"
)
# App Store Connect's "6.7-inch / 6.5-inch" slot for this app
# accepts these two resolutions only:
#   - 1284×2778 (iPhone 12/13/14 Pro Max - 6.7" slot, preferred)
#   - 1242×2688 (iPhone XS Max / 11 Pro Max - 6.5" slot)
# Any other size (e.g. 1290×2796 from iPhone 15 PM) is rejected
# at upload time. The 6.7" upload auto-fills the 6.5" slot.
VALID_RES_REGEX='^(1284x2778|2778x1284|1242x2688|2688x1242)$'
OUT_DIR="app-store-screenshots/iphone-67"
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
 Expected resolution: 1284×2778 (or 1242×2688)
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
    echo "  ⚠ $OUT is ${W}×${H} (expected 1284×2778 or 1242×2688)"
    echo "    App Store Connect will reject this size. Boot an iPhone"
    echo "    14 Pro Max (1284×2778) or 11 Pro Max (1242×2688) sim."
  else
    echo "  ✓ Saved $OUT (${W}×${H})"
  fi
  i=$((i + 1))
done

echo
echo "Done. ${OUT_DIR}/ contains $((i - 1)) screenshot(s)."
echo "Next: open https://appstoreconnect.apple.com → Apps → your app"
echo "      → Distribution → iOS App → 6.7\" and drag-drop the PNGs."
