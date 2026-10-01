# coconut

A desktop coding-agent app: chat with an agent that works in a folder you
choose, watch its unified railed timeline of messages and tool calls, and
approve every file edit before it lands. Agent output documents render
into a fenced content panel.

Architecture (see PLAN.md for the full spec):

```
┌──────────────┐   JSONL RPC   ┌───────────────┐   Wails IPC   ┌──────────────┐
│ pi sidecar   │ ◄───────────► │ Go backend    │ ◄───────────► │ React UI     │
│ (agent loop) │               │ (actor, seq,  │               │ (UI store,   │
│ + coconut.ts │               │  snapshots)   │               │  components) │
└──────────────┘               │  spawns ──► login helper (on demand)        │
                               └───────────────┘               └──────────────┘
```

- **pi sidecar** — the real `pi` agent in `--mode rpc`, launched with an
  isolated config dir and our extension (`pi-extension/coconut.ts`), which
  registers the `propose_edit` / `show_content` tools and gates bash
  commands behind approvals (with a whitelist).
- **login helper** (`pi-login/helper.ts`, compiled to `coconut-login`) — a
  small JSONL driver over pi's `ModelRuntime` that performs provider
  OAuth handshakes and API-key storage on the backend's behalf (pi's RPC
  mode has no login command). Spawned on demand, one process per operation.
- **Go backend** (`internal/core`, `internal/piadapter`, `internal/pilogin`)
  — owns domain state, normalizes pi events, sequences everything with a
  global `seq`, serves snapshots, bridges approvals, and owns the helper
  lifecycle.
- **React frontend** (`frontend/`) — event-driven UI: two-panel layout
  (chat timeline | content panel), resizable/collapsible, and a sidebar
  settings modal (structured Provider panel + raw YAML Advanced pane).

## Develop

Requires Go ≥ 1.24, Node ≥ 20, Bun, and the wails **v3** CLI
(`go install github.com/wailsapp/wails/v3/cmd/wails@beta`, which installs
as `wails3`; ensure `~/go/bin` is on PATH). The v2 CLI (`wails`) does not
understand a v3 go.mod.

```bash
# 1. Token-free development against the scripted fake sidecar:
go build -o build/bin/fakepi ./cmd/fakepi
export COCONUT_PI_BINARY="$PWD/build/bin/fakepi"
export COCONUT_PI_SCENARIO="$PWD/testdata/scenarios/todo-app.json"
wails3 dev

# 2. Against the real pi. The app resolves its sidecar + login helper from
#    build/sidecar/, so build them once first (needs the global pi package
#    and bun; both binaries are ~70MB):
scripts/build-sidecar.sh
unset COCONUT_PI_BINARY COCONUT_PI_SCENARIO
wails3 dev
```

Then sign in through the app: settings gear → **Provider** → pick a
provider → **Sign in** (OAuth flows, e.g. GitHub Copilot device-code, run
fully in the UI) — or paste an API key. Credentials land in pi's
credential store (`auth.json` in the isolated config dir), never in
`settings.yaml`. The header dot shows the current provider's credential
status at a glance.

Useful env overrides: `COCONUT_CONFIG_DIR` (app config location),
`COCONUT_EXTENSION` (extension path), `COCONUT_BASH_WHITELIST` (extra
bash prefixes, comma-separated), `COCONUT_LOGIN_HELPER` (helper binary
path, e.g. for tests).

## Test

```bash
go test ./...          # backend unit + fakepi integration tests
cd frontend && npx vitest run   # UI store tests
```

## Package (macOS)

```bash
scripts/build-sidecar.sh   # compile coconut-pi + coconut-login (if missing)
scripts/package.sh         # wails build + bundle + codesign (ad-hoc)
open bin/coconut.app
```

The packaged app is self-contained: the pi sidecar (`coconut-pi`), the
login helper (`coconut-login`), and the coconut extension all sit next to
the app binary inside the bundle (`Contents/MacOS/`).
