#!/usr/bin/env bash
# package.sh — produce a self-contained macOS coconut.app via wails3 package.
# wails3 package handles: sidecar build, frontend build, go build,
# app bundle creation, sidecar copy, and ad-hoc codesign.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/go/bin:$PATH"

cd "$ROOT"
wails3 package

echo "packaged: $ROOT/bin/coconut.app (sidecar embedded)"
