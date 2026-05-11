#!/usr/bin/env bash
#
# Sync src/vendor/reachy-mini.js with the upstream pollen-robotics/reachy_mini
# SDK at a given ref, then re-apply the mobile-only diagnostic patches that
# we don't want to upstream.
#
# Usage:
#   scripts/sync-vendor-sdk.sh                   # default ref (see DEFAULT_REF below)
#   scripts/sync-vendor-sdk.sh main              # pull from main once PR #1098 lands
#   scripts/sync-vendor-sdk.sh v0.7.3            # pin to a tag
#   scripts/sync-vendor-sdk.sh feat/something    # try a feature branch
#
# What this script does, in order:
#   1. Downloads `js/reachy-mini.js` from raw.githubusercontent.com at the
#      requested ref into src/vendor/reachy-mini.js.
#   2. Re-applies the local "/send rejected" 400-logging patch (mobile-only;
#      see PATCH_FN_LOG_SEND_400 below for the exact change). The patch is
#      idempotent: re-running this script never doubles the patch.
#   3. Verifies that all expected upstream fix markers (silent mic fallback,
#      ICE buffer, empty-ICE skip) are present in the synced file.
#   4. Prints a summary of what was synced and warns about the local
#      patches that are now layered on top.
#
# After running this script, sanity-check with `yarn tsc --noEmit` and a
# manual smoke test of the conversation flow before committing.

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────

# Default ref. Bump this when PR #1098 lands on `main`. The current pin is
# the integration branch carrying the four iframe-handoff fixes the mobile
# shell needs (preselectedRobotId, skip empty ICE, buffer ICE before SDP,
# silent mic fallback).
DEFAULT_REF="feat/sdk-mobile-shell-handoff"

UPSTREAM_OWNER="pollen-robotics"
UPSTREAM_REPO="reachy_mini"
UPSTREAM_PATH="js/reachy-mini.js"
LOCAL_PATH="src/vendor/reachy-mini.js"

# Markers that MUST be present in the synced file. If any is missing the
# upstream we just pulled is too old or has regressed, and the script bails
# before overwriting the local copy with something broken.
REQUIRED_MARKERS=(
    "_silentMicFallback"           # silent mic fallback on getUserMedia rejection
    "_pendingRemoteIce"            # buffer ICE candidates before setRemoteDescription
    "msg.ice.candidate"            # skip empty ICE candidate (Safari/iOS marker)
    # Awaitable wake_up / goto_sleep. Without these, `robot.wakeUp()` /
    # `robot.gotoSleep()` are fire-and-forget (return boolean), the
    # `await` in `physical.ts` is a no-op, and the engine ends up:
    #   - flipping FSM to `ready` BEFORE the wake animation finishes
    #     (the connecting view's "Wake-up" step is invisible);
    #   - calling `setMotorMode('disabled')` BEFORE the goto-sleep
    #     trajectory has landed (the head drops mid-animation).
    # See physical.ts + ConnectingView.tsx for the consumers, and the
    # PR #1098 thread upstream for the full plumbing rationale.
    "_pendingMotionCompletions"    # queue of pending wake_up / goto_sleep awaiters
    "_sendCommandAwaitCompletion"  # internal Promise wrapper for motion commands
)

# ─── Locate the script + repo root ─────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ─── Parse args ────────────────────────────────────────────────────────────

REF="${1:-$DEFAULT_REF}"

# URL-encode slashes in branch names (e.g. feat/sdk-mobile-shell-handoff).
# raw.githubusercontent.com expects the path components un-encoded actually,
# so we DO leave the slashes as-is. The line below is a no-op kept for
# clarity in case we ever switch to an API endpoint that needs encoding.
REF_FOR_URL="$REF"

UPSTREAM_URL="https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/${REF_FOR_URL}/${UPSTREAM_PATH}"

# ─── Step 1: Download ──────────────────────────────────────────────────────

echo "→ syncing $LOCAL_PATH from $UPSTREAM_OWNER/$UPSTREAM_REPO @ $REF"
echo "  $UPSTREAM_URL"

TMP_FILE="$(mktemp -t reachy-mini-sdk.XXXXXX.js)"
trap 'rm -f "$TMP_FILE"' EXIT

http_status=$(curl -sSL -w "%{http_code}" -o "$TMP_FILE" "$UPSTREAM_URL")
if [[ "$http_status" != "200" ]]; then
    echo "✗ download failed: HTTP $http_status from $UPSTREAM_URL" >&2
    echo "  ref '$REF' might not exist, or the SDK was moved. aborting." >&2
    exit 1
fi

# Sanity check: file must be > 10 KB (the SDK is ~65 KB; anything tiny is
# a 404 page rendered as text or a partial download).
size=$(wc -c < "$TMP_FILE" | tr -d ' ')
if (( size < 10240 )); then
    echo "✗ downloaded file is suspiciously small ($size bytes). aborting." >&2
    head -10 "$TMP_FILE" >&2
    exit 1
fi
echo "  ↓ $size bytes downloaded"

# ─── Step 2: Verify upstream contains the required markers ────────────────

echo "→ verifying upstream has all required SDK fixes"
missing=()
for marker in "${REQUIRED_MARKERS[@]}"; do
    if ! grep -q -- "$marker" "$TMP_FILE"; then
        missing+=("$marker")
    fi
done
if (( ${#missing[@]} > 0 )); then
    echo "✗ upstream at ref '$REF' is missing required markers:" >&2
    for m in "${missing[@]}"; do
        echo "    - $m" >&2
    done
    echo "  this is older than PR #1098 or regressed. aborting before overwrite." >&2
    exit 1
fi
echo "  ✓ all required markers present"

# ─── Step 3: Apply mobile-only "/send rejected" 400 log patch ─────────────

# We surface 4xx replies from the central's /send endpoint with the
# message type that triggered them. Upstream swallows them silently,
# returning null, which is correct for the SDK's contract but unhelpful
# during mobile-shell debugging where these tardy `peer`/`endSession`
# /`setPeerStatus` races are the only signal that something just got
# torn down at the wrong moment. Mobile-only because we don't want to
# pollute every consumer's console.
#
# The awk script anchors on the unique `body: JSON.stringify(message),`
# line followed by `})`, then walks forward to the `return await
# res.json();` and inserts our `if (!res.ok) { … }` block right before
# it. Idempotent: if the marker `[reachy-mini] /send rejected` is
# already present in the surrounding hunk, awk leaves the file alone.

echo "→ applying mobile-only patch: /send 400 logging"

if grep -q '\[reachy-mini\] /send rejected' "$TMP_FILE"; then
    echo "  ✓ patch already present upstream (great, less local divergence)"
    cp "$TMP_FILE" "$LOCAL_PATH"
else
    awk '
        # Track when we are inside the _sendToServer fetch block.
        /_sendToServer/ { in_send = 1 }
        in_send && /body: JSON\.stringify\(message\),/ { saw_body = 1 }
        # The very next "return await res.json();" after the body line is
        # our insertion anchor. Print our block FIRST, then the line.
        in_send && saw_body && /return await res\.json\(\);/ {
            print "            if (!res.ok) {"
            print "                // Central refused this message. The browser already logs"
            print "                // the bare \"Failed to load resource: 400\" line; surface"
            print "                // the message type and (when available) the central\x27s"
            print "                // explanation so we can tell which call produced the"
            print "                // race (typically a tardy `peer`/`endSession`/`setPeer"
            print "                // Status` after the session has been torn down)."
            print "                let body = \x27\x27;"
            print "                try { body = await res.text(); } catch { /* ignore */ }"
            print "                console.warn("
            print "                    `[reachy-mini] /send rejected (${res.status}) for type=${message?.type}; body=${body || \x27<empty>\x27}`,"
            print "                );"
            print "                return null;"
            print "            }"
            saw_body = 0
            in_send = 0
        }
        { print }
    ' "$TMP_FILE" > "$LOCAL_PATH"

    # Verify the patch landed.
    if ! grep -q '\[reachy-mini\] /send rejected' "$LOCAL_PATH"; then
        echo "✗ awk patch did not produce the expected marker." >&2
        echo "  upstream may have refactored _sendToServer; bailing out." >&2
        # Restore the unpatched file so the user sees what we got.
        cp "$TMP_FILE" "$LOCAL_PATH"
        exit 1
    fi
    echo "  ✓ patched"
fi

# ─── Step 4: Summary ──────────────────────────────────────────────────────

echo ""
echo "─── sync complete ────────────────────────────────────────────────"
echo "  ref:   $REF"
echo "  bytes: $(wc -c < "$LOCAL_PATH" | tr -d ' ')"
echo "  lines: $(wc -l < "$LOCAL_PATH" | tr -d ' ')"
echo ""
echo "  upstream markers present:"
for marker in "${REQUIRED_MARKERS[@]}"; do
    n=$(grep -c -- "$marker" "$LOCAL_PATH" || echo 0)
    printf "    %-30s %d match(es)\n" "$marker" "$n"
done
echo ""
echo "  local patches layered on top:"
n=$(grep -c -- '/send rejected' "$LOCAL_PATH" || echo 0)
printf "    %-30s %d match(es)\n" "/send 400 logging" "$n"
echo ""
echo "  next steps:"
echo "    1. yarn tsc --noEmit       # type-check"
echo "    2. yarn tauri:dev          # smoke-test the conversation flow"
echo "    3. git diff $LOCAL_PATH    # eyeball the actual changes"
echo "    4. commit if the diff is what you expect"
