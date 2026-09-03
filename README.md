# coconut

A desktop coding-agent app: chat with an agent that works in a folder you
choose, watch its tool calls live, and approve every file edit before it
lands. Agent output documents render into a fenced content panel.

Architecture (see PLAN.md for the full spec):

```
┌──────────────┐   JSONL RPC   ┌───────────────┐   Wails IPC   ┌──────────────┐
│ pi sidecar   │ ◄───────────► │ Go backend    │ ◄───────────► │ React UI     │
│ (agent loop) │               │ (actor, seq,  │               │ (UI store,   │
│ + coconut.ts │               │  snapshots)   │               │  components) │
└──────────────┘               └───────────────┘               └──────────────┘
```

- **pi sidecar** — the real `pi` agent in `--mode rpc`, launched with an
  isolated config dir and our extension (`pi-extension/coconut.ts`), which
  registers the `propose_edit` / `show_content` tools and gates bash
  commands behind approvals (with a whitelist).
- **Go backend** (`internal/core`, `internal/piadapter`) — owns domain
  state, normalizes pi events, sequences everything with a global `seq`,
  serves snapshots, and bridges approvals.
- **React frontend** (`frontend/`) — event-driven UI per `mockup.html`:
  tool log | chat | content panel, resizable/collapsible, settings modal.

## Develop

Requires Go ≥ 1.24, Node ≥ 20, Bun, and the wails CLI
(`go install github.com/wailsapp/wails/v2/cmd/wails@latest`; ensure
`~/go/bin` is on PATH).

```bash
# 1. Token-free development against the scripted fake sidecar:
go build -o build/bin/fakepi ./cmd/fakepi
export COCONUT_PI_BINARY="$PWD/build/bin/fakepi"
export COCONUT_PI_SCENARIO="$PWD/testdata/scenarios/todo-app.json"
wails dev

# 2. Against the real pi (uses your system `pi`; the app's isolated
#    config means you enter an API key in the settings modal once):
unset COCONUT_PI_BINARY COCONUT_PI_SCENARIO
wails dev
```

Useful env overrides: `COCONUT_CONFIG_DIR` (app config location),
`COCONUT_EXTENSION` (extension path), `COCONUT_BASH_WHITELIST` (extra
bash prefixes, comma-separated).

## Test

```bash
go test ./...          # backend unit + fakepi integration tests
cd frontend && npx vitest run   # UI store tests
```

## Package (macOS)

```bash
scripts/package.sh     # wails build + bun-compiled pi sidecar + codesign (ad-hoc)
open build/bin/coconut.app
```

The packaged app is self-contained: the pi sidecar (single ~70MB binary
plus its `theme/` etc. assets) and the coconut extension sit next to the
app binary inside the bundle.
