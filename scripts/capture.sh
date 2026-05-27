#!/usr/bin/env bash
# capture.sh
# ──────────
# Tiny helper to capture one App Store screenshot from the currently
# booted iOS simulator into the next NN.png slot under
# `app-store-screenshots/iphone-67/`.
#
# Usage (from this app's root):
#   scripts/capture.sh           # auto-number  -> 01.png, 02.png, …
#   scripts/capture.sh hero      # named slot   -> hero.png
#   scripts/capture.sh 03        # overwrite    -> 03.png
#
# Prereq: the helper-launcher script (or your IDE / manual Xcode run)
# has already booted a sim. The script targets the `booted` device.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="app-store-screenshots/iphone-67"
# App Store Connect's review queue for this app only accepts the
# 6.7" / 6.5" slots, NOT the newer 6.9" slot. Valid sizes are:
#   - 1284×2778 (iPhone 12/13/14 Pro Max, 6.7" slot, preferred)
#   - 1242×2688 (iPhone XS Max / 11 Pro Max, 6.5" slot, fallback)
# A 6.7" upload auto-fills the 6.5" slot, so one batch covers both.
# Reviewer rejection on a wrong size: "le screenshot doit être
# 1242 × 2688, 2688 × 1242, 1284 × 2778 ou 2778 × 1284".
VALID_RES_REGEX='^(1284x2778|2778x1284|1242x2688|2688x1242)$'
mkdir -p "$OUT_DIR"

name="${1:-}"
if [[ -z "$name" ]]; then
  next=1
  while [[ -e "$OUT_DIR/$(printf '%02d' $next).png" ]]; do
    next=$((next + 1))
  done
  name=$(printf '%02d' $next)
fi
OUT="$OUT_DIR/${name}.png"

# `simctl io` is launched inside the Simulator's TCC sandbox and
# cannot write into protected user folders (~/Documents, ~/Desktop,
# ~/Downloads). We capture into /tmp first and then move the file
# into the project tree, which the parent shell *can* write to.
TMP_PNG=$(mktemp -t store-screenshot-XXXXXX).png
xcrun simctl io booted screenshot "$TMP_PNG"
mv "$TMP_PNG" "$OUT"

W=$(sips -g pixelWidth  "$OUT" | awk '/pixelWidth/  {print $2}')
H=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/ {print $2}')
if [[ ! "${W}x${H}" =~ $VALID_RES_REGEX ]]; then
  echo "  ⚠ $OUT is ${W}×${H} (expected 1284×2778 or 1242×2688)" >&2
  echo "    App Store Connect will reject this size." >&2
  echo "    Boot an iPhone 14 Pro Max (1284×2778) or 11 Pro Max (1242×2688) sim." >&2
else
  echo "  ✓ $OUT (${W}×${H})"
fi
