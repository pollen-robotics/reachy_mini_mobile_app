#!/usr/bin/env bash
# Rebuild the local SDK checkout and refresh the vendored tarball.
#
# Used while the SDK branch (e.g. feat/host-update) is not published to npm:
# package.json points @pollen-robotics/reachy-mini-sdk at
# vendor/reachy-mini-sdk-branch.tgz. Run this script whenever the SDK
# branch changes, then restart the dev server.
#
# Usage: ./scripts/vendor-sdk.sh [path-to-reachy_mini-repo]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="${1:-$APP_DIR/../reachy_mini}/ts"

if [ ! -f "$SDK_DIR/package.json" ]; then
  echo "error: SDK not found at $SDK_DIR" >&2
  exit 1
fi

echo "==> Building SDK from $SDK_DIR ($(git -C "$SDK_DIR" rev-parse --abbrev-ref HEAD) @ $(git -C "$SDK_DIR" rev-parse --short HEAD))"
(cd "$SDK_DIR" && npm run build)

PACK_TMP="$(mktemp -d)"
TARBALL="$(cd "$SDK_DIR" && npm pack --pack-destination "$PACK_TMP" | tail -1)"
mkdir -p "$APP_DIR/vendor"
cp "$PACK_TMP/$TARBALL" "$APP_DIR/vendor/reachy-mini-sdk-branch.tgz"
rm -rf "$PACK_TMP"
echo "==> Updated vendor/reachy-mini-sdk-branch.tgz"

# Yarn caches file: tarballs by name+version; the branch build keeps the same
# placeholder version, so the cache must be purged for the new bits to land.
cd "$APP_DIR"
yarn cache clean @pollen-robotics/reachy-mini-sdk
yarn install --check-files
echo "==> Done. Restart the dev server to pick up the new SDK."
