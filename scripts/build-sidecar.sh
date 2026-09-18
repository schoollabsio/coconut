#!/usr/bin/env bash
# build-sidecar.sh — compile pi into a single executable and stage its
# runtime assets into build/sidecar/. Also compiles the coconut-login
# helper (auth flows) next to the sidecar binary.
#
# Validated recipe (see task 3 spike, pi 0.84.2):
#   1. bun build --compile <pi-pkg>/dist/bun/cli.js   ← the BUN entry, not dist/cli.js
#
# Why the bun entry: pi lazy-loads its OAuth flow modules (auth/oauth/load.js)
# via runtime import() so bundlers don't follow them. In a compiled binary
# that import only resolves if the flows were registered first — which
# dist/bun/cli.js does (registerBunOAuthFlows). Compiling the node entry
# (dist/cli.js) instead leaves OAuth credentials in auth.json unusable in
# the binary (env-var API keys still work). Verified 2026-09: Copilot
# device-code login + authenticated request succeed only with the bun entry.
#   2. stage theme/, export-html/, assets/, package.json, README.md,
#      CHANGELOG.md next to the binary (pi resolves them via getPackageDir()
#      when running as a Bun binary)
#   3. compile the login helper: pi-login/helper.ts imports
#      @earendil-works/pi-coding-agent by name (self-reference), which only
#      resolves when the entry file sits INSIDE the package dir — so we copy
#      it in, compile, and clean up. The helper ALSO calls
#      registerBunOAuthFlows() (pi-ai /bun-oauth) — required in a compiled
#      binary so the lazy-loaded OAuth flows are embedded instead of
#      runtime-imported (helper.ts header has the full story).
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
if [[ ! -f "$PI_PKG/dist/bun/cli.js" ]]; then
  echo "error: pi package not found at $PI_PKG" >&2
  exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('$PI_PKG/package.json'))['version'])")"
echo "bundling pi $VERSION from $PI_PKG"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

bun build --compile "$PI_PKG/dist/bun/cli.js" --outfile "$OUT_DIR/coconut-pi"

# Runtime assets expected next to the binary (pi getPackageDir() convention).
cp -r "$PI_PKG/dist/modes/interactive/theme" "$OUT_DIR/theme"
[[ -d "$PI_PKG/dist/core/export-html" ]] && cp -r "$PI_PKG/dist/core/export-html" "$OUT_DIR/export-html"
[[ -d "$PI_PKG/dist/modes/interactive/assets" ]] && cp -r "$PI_PKG/dist/modes/interactive/assets" "$OUT_DIR/assets"
cp "$PI_PKG/package.json" "$OUT_DIR/package.json"
[[ -f "$PI_PKG/README.md" ]] && cp "$PI_PKG/README.md" "$OUT_DIR/README.md"
[[ -f "$PI_PKG/CHANGELOG.md" ]] && cp "$PI_PKG/CHANGELOG.md" "$OUT_DIR/CHANGELOG.md"

# Our extension travels with the sidecar.
cp "$ROOT/pi-extension/coconut.ts" "$OUT_DIR/coconut-extension.ts" 2>/dev/null || true

# Login helper (coconut-login): headless driver for pi's auth flows.
# Self-reference import ⇒ the entry must live inside the pi package while
# bundling; the temp entry is removed on the way out.
HELPER_ENTRY="$PI_PKG/.coconut-login-helper-entry.ts"
trap 'rm -f "$HELPER_ENTRY"' EXIT
cp "$ROOT/pi-login/helper.ts" "$HELPER_ENTRY"
bun build --compile "$HELPER_ENTRY" --outfile "$OUT_DIR/coconut-login"

echo "sidecar staged at $OUT_DIR"
ls -la "$OUT_DIR"
