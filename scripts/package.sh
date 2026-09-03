#!/usr/bin/env bash
# package.sh — produce a self-contained macOS coconut.app:
#   1. wails build (compiles Go + embeds frontend/dist)
#   2. scripts/build-sidecar.sh (bun-compiles pi + stages assets)
#   3. copy the sidecar payload next to the app binary
#      (piadapter.ResolveBinary / resolveExtensionPath find it there)
#   4. ad-hoc re-sign so the bundle stays launchable
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/go/bin:$PATH"

cd "$ROOT"
wails build

"$ROOT/scripts/build-sidecar.sh" "$@"

MACOS_DIR="$ROOT/build/bin/coconut.app/Contents/MacOS"
if [[ ! -d "$MACOS_DIR" ]]; then
  echo "error: $MACOS_DIR not found (did wails build succeed?)" >&2
  exit 1
fi

cp -R "$ROOT/build/sidecar/." "$MACOS_DIR/"

# Re-sign after mutating the bundle (ad-hoc; replace with a real identity
# for distribution).
codesign --force --deep --sign - "$ROOT/build/bin/coconut.app" 2>/dev/null || true

echo "packaged: $ROOT/build/bin/coconut.app (sidecar embedded)"
