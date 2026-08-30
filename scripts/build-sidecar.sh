#!/usr/bin/env bash
# build-sidecar.sh — compile pi into a single executable and stage its
# runtime assets into build/sidecar/.
#
# Validated recipe (see task 3 spike, pi 0.84.2):
#   1. bun build --compile <pi-pkg>/dist/cli.js
#   2. stage theme/, export-html/, assets/, package.json, README.md,
#      CHANGELOG.md next to the binary (pi resolves them via getPackageDir()
#      when running as a Bun binary)
#
# Usage:
#   scripts/build-sidecar.sh [pi-package-dir]
#
# If pi-package-dir is omitted, the globally installed
# @earendil-works/pi-coding-agent is used. To pin a version instead:
#   npm install --prefix build/pi-pkg @earendil-works/pi-coding-agent@0.84.2
#   scripts/build-sidecar.sh build/pi-pkg/node_modules/@earendil-works/pi-coding-agent
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/build/sidecar"

PI_PKG="${1:-}"
if [[ -z "$PI_PKG" ]]; then
  PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"
fi
if [[ ! -f "$PI_PKG/dist/cli.js" ]]; then
  echo "error: pi package not found at $PI_PKG" >&2
  exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('$PI_PKG/package.json'))['version'])")"
echo "bundling pi $VERSION from $PI_PKG"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

bun build --compile "$PI_PKG/dist/cli.js" --outfile "$OUT_DIR/custard-pi"

# Runtime assets expected next to the binary (pi getPackageDir() convention).
cp -r "$PI_PKG/dist/modes/interactive/theme" "$OUT_DIR/theme"
[[ -d "$PI_PKG/dist/core/export-html" ]] && cp -r "$PI_PKG/dist/core/export-html" "$OUT_DIR/export-html"
[[ -d "$PI_PKG/dist/modes/interactive/assets" ]] && cp -r "$PI_PKG/dist/modes/interactive/assets" "$OUT_DIR/assets"
cp "$PI_PKG/package.json" "$OUT_DIR/package.json"
[[ -f "$PI_PKG/README.md" ]] && cp "$PI_PKG/README.md" "$OUT_DIR/README.md"
[[ -f "$PI_PKG/CHANGELOG.md" ]] && cp "$PI_PKG/CHANGELOG.md" "$OUT_DIR/CHANGELOG.md"

# Our extension travels with the sidecar.
cp "$ROOT/pi-extension/custard.ts" "$OUT_DIR/custard-extension.ts" 2>/dev/null || true

echo "sidecar staged at $OUT_DIR"
ls -la "$OUT_DIR"
