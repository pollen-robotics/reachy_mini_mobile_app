#!/usr/bin/env bash
# Rebuild the local SDK checkout and refresh the vendored tarball.
#
# Used while the SDK branch (e.g. feat/host-update) is not published to npm:
# package.json points @pollen-robotics/reachy-mini-sdk at a tarball under
# vendor/. Run this script whenever the SDK branch changes, then restart the
# dev server.
#
# The tarball gets a UNIQUE filename and version per pack (git sha +
# timestamp). This is not cosmetic: yarn 1 keys its cache, its lockfile
# `resolved` hash and its .yarn-integrity resolutions on the tarball's
# name+version+path, and NEVER re-reads a same-path tarball whose content
# changed - no amount of cache purging reliably evicts all layers. A fresh
# path+version sidesteps every one of them, and makes the installed build
# traceable (`require('.../package.json').version` shows branch sha).
#
# Usage: ./scripts/vendor-sdk.sh [path-to-reachy_mini-repo]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="${1:-$APP_DIR/../reachy_mini}/ts"

if [ ! -f "$SDK_DIR/package.json" ]; then
  echo "error: SDK not found at $SDK_DIR" >&2
  exit 1
fi

SDK_SHA="$(git -C "$SDK_DIR" rev-parse --short HEAD)"
STAMP="$(date +%s)"
DEV_VERSION="0.0.0-branch.${SDK_SHA}.${STAMP}"
TARBALL_NAME="reachy-mini-sdk-${SDK_SHA}-${STAMP}.tgz"

echo "==> Building SDK from $SDK_DIR ($(git -C "$SDK_DIR" rev-parse --abbrev-ref HEAD) @ $SDK_SHA)"
(cd "$SDK_DIR" && npm run build)

PACK_TMP="$(mktemp -d)"
(cd "$SDK_DIR" && npm version "$DEV_VERSION" --no-git-tag-version --allow-same-version >/dev/null)
PACKED="$(cd "$SDK_DIR" && npm pack --pack-destination "$PACK_TMP" | tail -1)"
# npm version touched package.json (and package-lock.json when present):
# restore so the SDK checkout stays clean.
(cd "$SDK_DIR" && git checkout -- package.json package-lock.json 2>/dev/null || git checkout -- package.json)

mkdir -p "$APP_DIR/vendor"
rm -f "$APP_DIR"/vendor/reachy-mini-sdk-*.tgz
cp "$PACK_TMP/$PACKED" "$APP_DIR/vendor/$TARBALL_NAME"
rm -rf "$PACK_TMP"
echo "==> vendor/$TARBALL_NAME ($DEV_VERSION)"

cd "$APP_DIR"
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.dependencies['@pollen-robotics/reachy-mini-sdk'] = 'file:vendor/$TARBALL_NAME';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
yarn install --check-files

# Trust nothing: assert the installed copy IS the freshly built one.
INSTALLED="node_modules/@pollen-robotics/reachy-mini-sdk/dist/lib/reachy-mini.js"
if ! cmp -s "$INSTALLED" "$SDK_DIR/dist/lib/reachy-mini.js"; then
  echo "error: installed SDK does not match the fresh build" >&2
  exit 1
fi
echo "==> Done ($(node -p "require('./node_modules/@pollen-robotics/reachy-mini-sdk/package.json').version")). Restart the dev server to pick up the new SDK."
