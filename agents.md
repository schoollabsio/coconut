# AGENTS.md — Custard: A human-in-the-loop coding agent

Custard is a desktop coding-agent app. An AI agent (`pi`) runs in a
sidecar; a Go backend owns domain state and the approval model; a React
UI renders tool log | chat | content panel and routes all edits through
propose_edit (the only file-modification channel).

Read `PLAN.md` (the full technical spec) and `README.md` first.

## Architecture at a glance

```
┌──────────────┐   JSONL RPC   ┌───────────────┐   Wails IPC   ┌──────────────┐
│ pi sidecar   │ ◄───────────► │ Go backend    │ ◄───────────► │ React UI     │
│ (agent loop) │               │ (actor, seq,  │               │ (UI store,   │
│ + custard.ts │               │  snapshots)   │               │  components) │
└──────────────┘               └───────────────┘               └──────────────┘
```

- **Go backend** (`internal/core`, `internal/piadapter`, `internal/protocol`) owns truth.
- **React frontend** (`frontend/`) owns only UI state, derived from backend events.
- **pi-extension/custard.ts** bridges pi's approval protocol to Custard.
- **cmd/fakepi** is a scripted stand-in for `pi --mode rpc` (tests + token-free dev).

## Layout

```
.
├── app.go, main.go            # Wails app bindings (Command / RequestSnapshot / emit)
├── PLAN.md                    # Technical specification (read this)
├── frontend/                  # React + TypeScript + Vite + Tailwind
│   ├── src/
│   │   ├── backend.ts         # BackendClient: Wails ↔ protocol bridge
│   │   ├── protocol.ts        # Mirror of internal/protocol (keep in sync)
│   │   ├── store.ts           # UIStore (single client-side state store)
│   │   ├── App.tsx            # Orchestrator: connect → snapshot → live events
│   │   ├── components/        # Chat, ToolLog, ContentPanel, Header, SettingsModal
│   │   └── index.css          # Tailwind import
│   └── dist/                  # Embedded via go:embed (built by `bun run build`)
├── internal/
│   ├── core/                  # Engine, domain state, normalizer, commands, settings, diff
│   ├── piadapter/             # JSONL RPC client + sidecar process lifecycle
│   └── protocol/              # Envelope types shared Go ↔ frontend
├── pi-extension/
│   └── custard.ts             # Registered pi extension: approve-gated tools
├── cmd/fakepi/                # Scripted pi stand-in for testing/dev
├── testdata/scenarios/        # .json scenario files for fakepi
└── scripts/                   # Packaging (macOS codesign, etc.)
```

## Key design principles

### 1. Approval-gated editing
The only file-modification channel is `propose_edit` (a pi tool registered
by `pi-extension/custard.ts`). Built-in `edit`/`write` tools are NOT
available. `write_content` writes documents to a file and promotes that
path into the content panel — it is NOT for editing source files.

When proposing edits, each `oldText` must match the file's current content
exactly; edits apply sequentially. A single edit with empty `oldText`
creates/overwrites a file. Check the tool result after proposing — never
assume approval. If dismissed, do NOT retry the same edit.

### 2. Go owns domain truth
The Go backend is a **single-writer actor** (`core.Engine.Run`). All domain
mutation happens on one goroutine (`internal/core/engine.go`). Frontend
commands are queued via `inbox`; pi events arrive via `inbox`; everything
is processed sequentially. The frontend derives UI state from backend
events/snapshots only.

### 3. Global sequencing
Every backend event carries a monotonically increasing `seq`. The frontend
checks for gaps (`ev.seq !== lastBackendSeq + 1`) and resyncs via snapshot.
Stream messages (token deltas) are unsequenced but coalesced (latest-wins
per stream, flushed ~12ms and on every sequenced event).

### 4. Stream payloads are cumulative
`agent.token` carries the cumulative text of the in-flight assistant
message (not deltas). This is documented in `protocol.go`'s package doc.
Transport is local, so bandwidth is irrelevant; cumulative payloads are
self-healing if a stream message is dropped.

### 5. No direct pi ↔ frontend access
The frontend talks only to Go. Go owns the pi process lifecycle and never
exposes pi events raw.

## Common workflows

### Dev against the fake sidecar (token-free)
```bash
go build -o build/bin/fakepi ./cmd/fakepi
export CUSTARD_PI_BINARY="$PWD/build/bin/fakepi"
export CUSTARD_PI_SCENARIO="$PWD/testdata/scenarios/todo-app.json"
wails dev
```

### Dev against the real pi
```bash
unset CUSTARD_PI_BINARY CUSTARD_PI_SCENARIO
wails dev
```
The app uses an isolated config dir; enter an API key once in the Settings
modal. CUSTARD_CONFIG_DIR overrides the config location.

### Add a new tool / approval kind
1. Register the tool in `pi-extension/custard.ts` with a
   `ctx.ui.confirm("custard://<kind>", jsonString)` gate.
2. In `internal/core/normalize.go`: handle `extension_ui_request` — parse
   the title, compute a diff (see `buildUnifiedDiff` in `diff.go`) if
   applicable, and call `registerApprovalLocked` with a new
   `protocol.ApprovalKind*`.
3. In `internal/protocol/protocol.go`: add the kind constant and the
   relevant `ApprovalRequest` fields (mirrored in `frontend/src/protocol.ts`).
4. In `frontend/src/components/ContentPanel.tsx`: add a branch for the new
   approval kind in `ApprovalView`.

### Add a frontend command
1. Add `CmdXxx = "xxx"` in `internal/protocol/protocol.go` AND the matching
   entry in `frontend/src/protocol.ts` (these are manually mirrored).
2. Add a `case protocol.CmdXxx:` in `internal/core/commands.go`.
3. Add a handler that either responds synchronously via the `respond` channel
   or uses `viaPi` for async pi-backed work.
4. Add the call site in the relevant React component using
   `client.command(Cmd.Xxx, {...})`.

### Add a backend event
1. Add `EvXxx = "xxx"` in `internal/protocol/protocol.go` AND
   `Ev.Xxx = "xxx"` in `frontend/src/protocol.ts`.
2. Emit it in `internal/core/normalize.go` via `e.emitEvent(...)`.
3. Handle it in `frontend/src/store.ts` within `applyEvent`'s switch.
   The store does NOT handle unknown events (safe to ignore v1 events
   your component doesn't need).

### Add a backend stream
1. Add `StreamXxx = "xxx"` in `internal/protocol/protocol.go` AND
   `Stream.Xxx = "xxx"` in `frontend/src/protocol.ts`.
2. Emit via `e.emitStream(...)` in the normalizer.
3. Handle in `frontend/src/store.ts` within `applyStream`. Note: streams
   are buffered and flushed on `requestAnimationFrame`; for high-frequency
   updates this is fine.

### Edit the diff preview for a file approval
The diff is computed server-side in `internal/core/diff.go`:
`applyEdits` (exact-match, first-occurrence-wins, sequential) produces
newContent; `buildUnifiedDiff` renders `--- a/file` / `+++ b/file` headers,
a `@@ proposed changes @@` hunk header, 3 lines of context, and `…`
elisions for collapsed context. The frontend (`DiffView` in
`ContentPanel.tsx`) renders by prefix: ` `, `-`, `+`, `@`, `…`.

## Testing

```bash
go test ./...                      # Go unit + fakepi integration
cd frontend && npx vitest run      # UI store tests
```

- Go tests live alongside their code (`*_test.go`).
- `internal/core/engine_test.go` exercises command handling and event
  normalization using fakepi.
- Frontend store tests go in `frontend/src/` with Vitest.
- `testdata/scenarios/*.json` drive fakepi for integration scenarios.

To write a fakepi scenario, see `cmd/fakepi/README.md` — the approval
wire contract is: pi emits `tool_execution_start` → `extension_ui_request`
(title `custard://propose_edit` / `custard://bash`, message is a JSON
**string**) → client answers `extension_ui_response` (`confirmed: true` or
`cancelled: true`) → pi emits `tool_execution_end`.

## Settings

`settings.yaml` lives in the app config dir (override with
`CUSTARD_CONFIG_DIR`). It is user-edited YAML; the backend owns parsing
and validation (`internal/core/settings.go`).

```yaml
provider: anthropic          # built-in (anthropic, openai, google, ...) or custom name
model: claude-sonnet-4-5     # optional: id, provider/model, or provider/model:thinking
apiKey: ""                   # plaintext here (0600); or read provider's env var
providers:                   # custom endpoints / built-in overrides → pi's models.json
  openrouter:
    baseUrl: https://openrouter.ai/api/v1
    api: openai-completions
    apiKey: sk-or-...
    models:
      - id: anthropic/claude-sonnet-4
bashWhitelist:               # prefixes the agent may run without approval
  - ls
  - git status
  - ...
```

Saving settings restarts the sidecar. Errors block saving (the modal
stays open); warnings are informational. Unknown provider keys pass
through to `models.json` as warnings.

## Protocol conventions (read `internal/protocol/protocol.go`)

- **Command** → **CommandResponse** (ok + payload | error {code, message})
- **Event**: sequenced (seq, name, payload, timestamp, correlationId)
- **Stream**: unsequenced, cumulative payload (agent.token, agent.tool.output)
- **Snapshot**: replaces backend-derived frontend state (seq + full state tree)

All messages share the base envelope: `{type, id?, payload, correlationId?, error?}`.

## Frontend architecture

- **`backend.ts`** — `BackendClient`: `command()`, `requestSnapshot()`, `onMessage()`.
  Wires onto Wails: `window.go.main.App.Command`, `.RequestSnapshot`, and
  `runtime.EventsOn("backend", ...)`. A single ordered Wails event channel
  carries every envelope, preserving backend sequence ordering end-to-end.
- **`store.ts`** — `UIStore`: a framework-free store with a React binding via
  `useSyncExternalStore`. It applies snapshots (full replace), events
  (seq-gapped → resync), and buffered streams (flushed via RAF). Does NOT
  own domain truth; derives UI state from backend messages.
- **`App.tsx`** — bootstrapper. Connects, buffers events before the first
  snapshot, sends `session.restore`, applies the snapshot, then drains the
  buffer. NOTE: no "booted" ref guard — React StrictMode in dev intentionally
  remounts effects; cleanup must fully undo setup.
- **Components** are dumb-ish: they read state via `useUIState(selector)`
  and send commands via `client.command(...)`. One-off subscriptions
  (e.g. approvals) use `useEffect` + `bus.on(...)`.

## Building and packaging

```bash
# Frontend build (needed before Go embed)
cd frontend && bun run build

# macOS package (self-contained app bundle)
scripts/package.sh
open build/bin/custard.app
```

The packaged app bundles: the Go binary, the embedded `frontend/dist`,
the pi sidecar (single ~70MB binary in `build/sidecar/`), and the
custard extension (`pi-extension/custard.ts`).

## Environment variables

| Variable | Purpose |
|---|---|
| `CUSTARD_PI_BINARY` | Override the sidecar binary path (dev/fakepi) |
| `CUSTARD_PI_SCENARIO` | Path to a fakepi scenario JSON |
| `CUSTARD_CONFIG_DIR` | Override the app config directory |
| `CUSTARD_EXTENSION` | Override the pi extension path |
| `CUSTARD_BASH_WHITELIST` | Extra comma-separated bash whitelist prefixes |
| `PI_CODING_AGENT_DIR` | (set by backend) isolated pi config dir |
| `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY` | (set by backend) pi behavior |

## Style notes

- Go: standard formatting (`gofmt`/`goimports`). Actor-only state accessed
  without locks (`domainState` in `state.go`). Public methods that send to
  `inbox` are safe from any goroutine.
- TypeScript/React: Tailwind for styling. Components use `useUIState`
  selectors — never subscribe to raw backend events as state sources.
  The `oldText` in `propose_edit` must match exactly (same invariant as
  the extension).
- `protocol.ts` is a **manual mirror** of `internal/protocol/protocol.go`.
  When you add a constant or type in one, update the other.
