#!/usr/bin/env bash
# capture-mac.sh
# ──────────────
# Capture an App Store screenshot from the running `yarn tauri:dev`
# window on a Mac with a Retina display, upscale to the iPhone 6.7"
# slot resolution (1284 × 2778), and save into the same output dir
# as `capture.sh` so both flows share the gallery.
#
# Why 6.7" (1284 × 2778) and not 6.9" (1290 × 2796)
# ─────────────────────────────────────────────────
# App Store Connect's slot policy for our app currently only accepts
# 6.5" (1242 × 2688) or 6.7" (1284 × 2778). Uploading a 6.9" frame
# triggers a hard validation error ("le screenshot doit être 1242 ×
# 2688, 1284 × 2778, etc"). We pick 6.7" because ASC auto-fills the
# 6.5" slot from a 6.7" upload, so a single batch of captures covers
# both slots with no duplicate work.
#
# Why this exists alongside capture.sh
# ────────────────────────────────────
# `capture.sh` shoots from the iOS Simulator, which is the cleanest
# path when WebRTC works. It doesn't on every host (the Simulator's
# WKWebView struggles with mDNS host candidates against the LAN
# robot - see chat history for the rationale), so for screens that
# need a live conversation orb we fall back to Tauri's desktop dev
# build, where WKWebView is the macOS one and WebRTC works fine.
#
# Both scripts converge on the same `app-store-screenshots/iphone-67/`
# folder so you can mix-and-match captures (sim-clean menus, dev-Mac
# WebRTC frames) before drag-dropping into App Store Connect.
#
# How it works
# ────────────
# The companion `yarn tauri:dev-screenshot` script launches Tauri's
# dev server with the `src-tauri/tauri.screenshot.conf.json` overlay,
# which deep-merges onto `tauri.conf.json` to:
#   * resize the main window to 428 × 926 pt (iPhone 14 Pro Max
#     logical size, so the layout renders with the exact column
#     width / safe-area math the production iOS build uses);
#   * set `decorations: false` so the macOS chrome (titlebar +
#     rounded corners) doesn't bleed into the capture.
# On a Retina display the window's backing store is 2× the logical
# size, so a region capture yields 856 × 1852 px. `sips -z` then
# upscales 1.5× to the App Store target 1284 × 2778. The 1.5×
# bicubic resample is well below what reviewers flag, and is the
# same trade Apple uses to regenerate the 6.5" slot from a 6.7"
# upload.
#
# Why region capture instead of `screencapture -w`
# ────────────────────────────────────────────────
# The interactive `-w` mode requires clicking the target window,
# which forces a focus change. That is unworkable for screens whose
# UI state depends on focus (active inputs, hovered tabs, orb idle
# state, drag affordances) - the capture would always show the
# moment *after* the click. By querying the window's frame via
# AppleScript and feeding it to `screencapture -R`, we capture the
# Tauri content area without touching it: keyboard focus stays in
# the terminal/IDE, mouse stays wherever you left it, and the
# Tauri window doesn't even need to be on top of the z-order as
# long as it isn't visually occluded. Re-run the script as many
# times as you need while navigating the app freely.
#
# Usage (from the app root)
# ─────────────────────────
#   yarn tauri:dev-screenshot            # in one terminal (keep running)
#   scripts/capture-mac.sh               # in another, auto-number -> 01.png, 02.png
#   scripts/capture-mac.sh hero          # named slot               -> hero.png
#   scripts/capture-mac.sh 03            # overwrite                -> 03.png
#
# Prereq: `yarn tauri:dev-screenshot` is running and the "Reachy
# Mini" borderless window is visible (not minimized, not fully
# behind another window) on a Retina display.
#
# If you run `yarn tauri:dev` (the regular dev workflow) instead,
# the capture will still work but include the macOS titlebar +
# rounded corners + a slightly off aspect ratio. ASC will reject
# such an upload. Always use the screenshot-specific dev script
# for shippable captures.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="app-store-screenshots/iphone-67"
# Apple's iPhone 6.7" slot is exactly 1284 × 2778 (iPhone 12/13/14
# Pro Max, scale-3 from 428 × 926 pt). ASC also accepts 1242 × 2688
# (6.5") in the same slot and auto-fills the 6.5" slot from the
# 6.7" upload, so one 1284 × 2778 batch covers both display classes.
TARGET_W=1284
TARGET_H=2778

PROCESS_NAME="reachy_mini_mobile_app"

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

# Read the Tauri window's logical frame (position + size in points)
# via the macOS Accessibility API exposed through System Events.
# Note: this requires "Accessibility" permission for whatever app is
# running this script (Terminal / iTerm / Cursor). If it errors with
# `osascript: ... not allowed assistive access`, grant the host app
# in System Settings → Privacy & Security → Accessibility.
#
# AppleScript subtlety: the `&` operator on two numbers builds a
# *list*, not a concatenated string, and osascript would then render
# that list with the user's locale separator (", " in fr-FR, varies
# elsewhere). To get a stable `x|y|w|h` line we coerce each integer
# to `string` *before* the `&` so `&` operates on strings (true
# concatenation). This avoids any AppleScript text-item-delimiters
# gymnastics and any apostrophes in the heredoc (which would trip
# up the bash parser inside `$(...)`).
geom=$(osascript <<APPLESCRIPT
tell application "System Events"
  set procs to (every process whose name is "$PROCESS_NAME")
  if (count of procs) = 0 then
    error "Tauri app not running. Start it with: yarn tauri:dev"
  end if
  tell process "$PROCESS_NAME"
    set p to position of window 1
    set s to size of window 1
    return ((item 1 of p) as string) & "|" & ((item 2 of p) as string) & "|" & ((item 1 of s) as string) & "|" & ((item 2 of s) as string)
  end tell
end tell
APPLESCRIPT
)

IFS='|' read -r X Y W H <<<"$geom"

if [[ -z "${X:-}" || -z "${Y:-}" || -z "${W:-}" || -z "${H:-}" ]]; then
  echo "  ✗ Could not parse window geometry (got: $geom)" >&2
  exit 1
fi

echo "  Window frame: ${W}×${H} @ (${X},${Y})"

# `screencapture -R<x>,<y>,<w>,<h>` captures the screen region in
# logical points; on a Retina display the resulting PNG is 2× in
# pixels. `-o` strips the macOS drop-shadow margin (no-op for -R
# but harmless). `-x` mutes the shutter sound so the capture is
# silent even when this runs in a loop.
TMP_PNG=$(mktemp -t tauri-dev-cap-XXXXXX).png
screencapture -o -x -R"${X},${Y},${W},${H}" "$TMP_PNG"

if [[ ! -s "$TMP_PNG" ]]; then
  echo "  ✗ Capture failed (no file written)." >&2
  rm -f "$TMP_PNG"
  exit 1
fi

# Pre-resize sanity log: helps diagnose "wrong display" issues
# (e.g. capturing a non-Retina external monitor would yield
# 428 × 926 px instead of 856 × 1852).
RAW_W=$(sips -g pixelWidth  "$TMP_PNG" | awk '/pixelWidth/  {print $2}')
RAW_H=$(sips -g pixelHeight "$TMP_PNG" | awk '/pixelHeight/ {print $2}')
echo "  Raw capture: ${RAW_W}×${RAW_H}"

# `sips -z H W` resamples with bicubic interpolation. We hand it the
# App Store target dimensions and let it preserve the aspect (which
# matches because the Tauri window is configured 428 × 926 = same
# aspect as 1284 × 2778).
sips -z "$TARGET_H" "$TARGET_W" "$TMP_PNG" --out "$OUT" >/dev/null

FINAL_W=$(sips -g pixelWidth  "$OUT" | awk '/pixelWidth/  {print $2}')
FINAL_H=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/ {print $2}')
if [[ "$FINAL_W" == "$TARGET_W" && "$FINAL_H" == "$TARGET_H" ]]; then
  echo "  ✓ $OUT (${FINAL_W}×${FINAL_H})"
else
  echo "  ⚠ $OUT is ${FINAL_W}×${FINAL_H} (expected ${TARGET_W}×${TARGET_H})" >&2
fi

rm -f "$TMP_PNG"
