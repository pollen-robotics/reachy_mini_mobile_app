#!/usr/bin/env bash
# capture.sh
# ──────────
# Tiny helper to capture one App Store screenshot from the currently
# booted iOS simulator into the next NN.png slot under
# `app-store-screenshots/iphone-69/`.
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

OUT_DIR="app-store-screenshots/iphone-69"
# App Store Connect accepts either iPhone Pro Max resolution
# for the "iPhone 6.9-inch" slot:
#   - 1320×2868 (iPhone 16/17 Pro Max, native @460ppi, preferred)
#   - 1290×2796 (iPhone 15 Pro Max, still accepted as fallback)
VALID_RES_REGEX='^(1320x2868|2868x1320|1290x2796|2796x1290)$'
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
  echo "  ⚠ $OUT is ${W}×${H} (expected 1320×2868 or 1290×2796)" >&2
  echo "    App Store Connect may reject this size." >&2
else
  echo "  ✓ $OUT (${W}×${H})"
fi
