# AGENTS.md — Coconut: A human-in-the-loop coding agent

Coconut is a desktop coding-agent app: chat with an agent that works in a
folder you choose, watch its tool calls live, and approve every file edit
before it lands. Agent output documents render into a fenced content panel.

Architecture:

```
┌──────────────┐   JSONL RPC   ┌───────────────┐   Wails IPC   ┌──────────────┐
│ pi sidecar   │ ◄───────────► │ Go backend    │ ◄───────────► │ React UI     │
│ (agent loop) │               │ (actor, seq,  │               │ (UI store,   │
│ + coconut.ts │               │  snapshots)   │               │  components) │
└──────────────┘               └───────────────┘               └──────────────┘
```

- **pi sidecar** — the real `pi` agent in `--mode rpc`, launched with an
  isolated config dir and the coconut extension (`pi-extension/coconut.ts`),
  which registers `propose_edit` / `show_content` tools and gates bash
  commands behind approvals (with a whitelist).
- **Go backend** (`internal/core`, `internal/piadapter`, `internal/protocol`) —
  owns domain state, normalizes pi events, sequences everything with a global
  `seq`, serves snapshots, and bridges approvals. Single-writer actor.
- **React frontend** (`frontend/`) — event-driven UI: tool log | chat |
  content panel, resizable/collapsible, settings modal.

Read `PLAN.md` (the full technical spec) and `README.md` first.

---

## Key design principles

### 1. Approval-gated editing
The **only** file-modification channel is `propose_edit` (a pi tool
registered by `pi-extension/coconut.ts`). Built-in `edit`/`write` tools are
NOT available. When proposing edits, each `oldText` must match the file's
current content exactly; edits apply sequentially.

### 2. Go owns domain truth
The Go backend is a **single-writer actor** (`core.Engine.Run`). All domain
mutation happens on one goroutine. Frontend commands are queued via `inbox`;
pi events arrive via `inbox`; everything is processed sequentially.

### 3. Global sequencing
Every backend event carries a monotonically increasing `seq`. The frontend
checks for gaps (`ev.seq !== lastBackendSeq + 1`) and resyncs via snapshot.
Stream messages (token deltas) are unsequenced but coalesced (latest-wins
per stream, flushed ~12ms and on every sequenced event).

### 4. Stream payloads are cumulative
`agent.token` carries the cumulative text of the in-flight assistant message
(not deltas). `agent.tool.output` carries cumulative partial output. This
makes dropped messages self-healing.

### 5. No direct pi ↔ frontend access
The frontend talks only to Go. Go owns the pi process lifecycle and never
exposes pi events raw.

---

## Layout

```
.
├── app.go, main.go            # Wails app bindings (Command / RequestSnapshot / emit)
├── PLAN.md                    # Technical specification (read this)
├── AGENTS.md                  # This file
├── README.md                  # Project overview + dev/packaging instructions
├── frontend/                  # React + TypeScript + Vite + Tailwind
│   ├── src/
│   │   ├── backend.ts         # BackendClient: Wails ↔ protocol bridge
│   │   ├── protocol.ts        # Mirror of internal/protocol (keep in sync)
│   │   ├── store.ts           # UIStore (single client-side state store)
│   │   ├── store.test.ts      # Vitest tests for the store
│   │   ├── App.tsx            # Orchestrator: connect → snapshot → live events
│   │   ├── components/        # Chat, ToolLog, ContentPanel, Header, SettingsModal
│   │   └── index.css          # Tailwind import
│   └── dist/                  # Embedded via go:embed (built by `bun run build`)
├── internal/
│   ├── core/                  # Engine, domain state, normalizer, commands, settings, diff
│   │   ├── engine.go          # Actor loop, emission, stream coalescing
│   │   ├── commands.go        # Command routing (frontend → backend)
│   │   ├── normalize.go       # pi event normalization (pi → domain)
│   │   ├── state.go           # domainState (actor-owned, no locks)
│   │   ├── sidecar.go         # Sidecar lifecycle, launch spec, session restore
│   │   ├── settings.go        # settings.yaml parsing, validation, models.json generation
│   │   ├── diff.go            # applyEdits, buildUnifiedDiff
│   │   └── *_test.go          # Integration tests against fakepi
│   ├── piadapter/
│   │   └── piadapter.go        # JSONL RPC client + sidecar process lifecycle
│   └── protocol/
│       └── protocol.go         # Envelope types shared Go ↔ frontend
├── pi-extension/
│   └── coconut.ts              # Registered pi extension: approve-gated tools
├── cmd/fakepi/                 # Scripted pi stand-in for testing/dev
│   ├── main.go                 # CLI entry
│   ├── scenario.go             # Scenario step execution
│   ├── state.go                # Fakepi internal state
│   └── README.md               # Detailed wiring contract docs
├── testdata/scenarios/         # .json scenario files for fakepi
├── scripts/                    # Packaging (macOS codesign, etc.)
├── go.mod
├── wails.json
└── .gitignore
```

---

## Development

Requires Go ≥ 1.24 (go.mod says go 1.26), Node ≥ 20, and the wails CLI:
```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

### Dev against the fake sidecar (token-free)

```bash
go build -o build/bin/fakepi ./cmd/fakepi
export COCONUT_PI_BINARY="$PWD/build/bin/fakepi"
export COCONUT_PI_SCENARIO="$PWD/testdata/scenarios/todo-app.json"
wails dev
```

### Dev against the real pi

```bash
unset COCONUT_PI_BINARY COCONUT_PI_SCENARIO
wails dev
```
The app uses an isolated config dir; enter an API key once in the Settings
modal. `COCONUT_CONFIG_DIR` overrides the config location.

---

## Common workflows

### Add a new tool / approval kind
1. Register the tool in `pi-extension/coconut.ts` with a
   `ctx.ui.confirm("coconut://<kind>", jsonString)` gate.
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
   The store does NOT handle unknown events (safe to ignore v1 events your
   component doesn't need).

### Add a backend stream
1. Add `StreamXxx = "xxx"` in `internal/protocol/protocol.go` AND
   `Stream.Xxx = "xxx"` in `frontend/src/protocol.ts`.
2. The stream payload should be cumulative (latest-wins per item).
3. Emit via `e.emitStream(...)`.
4. Handle in `frontend/src/store.ts` within `applyStream`. Streams are
   buffered and flushed via `requestAnimationFrame`; for high-frequency
   updates this is fine.

### Edit the diff preview for a file approval
The diff is computed server-side in `internal/core/diff.go`:
`applyEdits` (exact-match, first-occurrence-wins, sequential) produces
newContent; `buildUnifiedDiff` renders `--- a/file` / `+++ b/file` headers,
a `@@ proposed changes @@` hunk header, 3 lines of context, and `…`
elisions for collapsed context. The frontend (`DiffView` in
`ContentPanel.tsx`) renders by prefix: ` `, `-`, `+`, `@`, `…`.

---

## Protocol conventions (read `internal/protocol/protocol.go`)

- **Command** → **CommandResponse** (ok + payload | error {code, message})
- **Event**: sequenced (seq, name, payload, timestamp, correlationId)
- **Stream**: unsequenced, cumulative payload (agent.token, agent.tool.output)
- **Snapshot**: replaces backend-derived frontend state (seq + full state tree)

All messages share the base envelope: `{type, id?, payload, correlationId?, error?}`.

### Commands (frontend → backend)
| Command | Payload | Description |
|---|---|---|
| `session.restore` | `{}` | Startup bootstrap: reopen last workspace's last agent |
| `agent.open` | `{slug\|name, sessionFile?, new?}` | Open/create an agent, optionally at a session |
| `agent.rename` | `{name}` | Rename the current agent (dir move deferred) |
| `agent.reset` | `{}` | New underlying pi session for the current agent |
| `agent.list` | `{}` | Scan workspace agents + sessions |
| `workspace.pick` | `{}` | Open native directory picker |
| `workspace.set` | `{path}` | Set workspace; responds `{workspace, agents, needsPick}` — when agents exist the sidecar does NOT auto-start (frontend shows the picker) |
| `agent.start` | `{prompt}` | Start an agent run |
| `agent.cancel` | `{}` | Cancel current agent run |
| `agent.approval.respond` | `{approvalId, decision}` | Respond to an approval |
| `settings.get` | `{}` | Get current settings.yaml text |
| `settings.validate` | `{yaml}` | Dry-run validate YAML |
| `settings.save` | `{yaml}` | Validate + persist + restart sidecar |

### Events (backend → frontend)
| Event | Stream? | Description |
|---|---|---|
| `session.restored` | No | Agent/session opened; frontend re-pulls a snapshot |
| `workspace.changed` | No | Workspace changed; payload `{workspace, agents, needsPick}` |
| `agent.session.reset` | No | New pi session started in place (transcript kept on disk) |
| `agent.started` | No | Agent session started |
| `agent.status.changed` | No | Agent status (idle/thinking/streaming/awaiting_approval/error) |
| `agent.message.appended` | No | New message in conversation |
| `agent.tool.started` | No | Tool call began |
| `agent.tool.completed` | No | Tool call finished |
| `agent.approval.requested` | No | Approval requested (surfaced as UI) |
| `agent.approval.resolved` | No | Approval resolved |
| `agent.completed` | No | Agent run finished |
| `agent.failed` | No | Agent run failed |
| `agent.sidecar.lost` | No | Sidecar process exited unexpectedly |
| `content.updated` | No | show_content document promoted to content panel |
| `settings.changed` | No | Settings updated |
| `notification.created` | No | Show a notification |

### Streams
| Stream | Payload | Notes |
|---|---|---|
| `agent.token` | `{messageId, text}` | Cumulative text of in-flight assistant message |
| `agent.tool.output` | `{toolCallId, text}` | Cumulative partial tool output |

### Approval kinds
| Kind | Fields |
|---|---|
| `propose_edit` | `path`, `what`, `why`, `diff` |
| `bash` | `command` |

### Approval decisions
`allow` (approve) or `dismiss` (skip — the agent is told in chat, not retried automatically).

---

## Backend architecture

### Engine (`internal/core/engine.go`) — single-writer actor
All state mutation on one goroutine via `inbox` channel. Public methods
(`HandleCommand`, `RequestSnapshot`, `Shutdown`) send to `inbox`; they're
safe from any goroutine.

Key methods:
- `Run(ctx)` — the actor loop
- `handle(in)` — dispatches `cmdInput`, `snapshotInput`, `piEventInput`,
  `piRespInput`, `flushInput`, `shutdownInput`
- `emitEvent(name, payload, correlationID)` — flushes pending streams first,
  assigns next `seq`, emits via `cfg.Emit`
- `emitStream(name, payload)` — coalesces (latest-wins per name), schedules
  flush via `time.AfterFunc(12ms)`
- `sendPi(name, fields, cont)` — sends a pi command, runs continuation on
  the actor goroutine via `piRespInput`

### Command routing (`internal/core/commands.go`)
Maps `CmdXxx` → `cmdXxx` handler. Handlers respond synchronously via the
buffered `respond` channel, or use `viaPi` for async pi-backed work.
**Never block the actor waiting for a continuation** — that deadlocks.

### Event normalization (`internal/core/normalize.go`)
Translates raw pi events into domain mutations + backend emissions.
`setStatus` only emits `agent.status.changed` on transitions.
`extension_ui_request` events with `coconut://` titles are bridged to
approval requests; `notify` method events pass through as notifications.
`show_content` completions promote the call args into the content panel
doc: mode A (`path`+`content`) renders the composed document; mode B
(`file`) re-reads the named file off disk (relative to the workspace) so
its contents never enter the model transcript. Errors become notifications.

### Sidecar lifecycle (`internal/core/sidecar.go`)
- `startSidecarLocked` — launches pi, pumps events via goroutine → `inbox`,
  does post-start `get_state`, optionally restores session via
  `switch_session`, rebuilds message history.
- `stopSidecarLocked` — closes pi client + kills process.
- `onSidecarGone` — handles unexpected exit: emits `agent.sidecar.lost` and
  `agent.failed`, then single automatic restart with session restore.
- `buildLaunchSpec` — assembles the pi command line; checks
  `COCONUT_PI_BINARY` for dev/fakepi.

### Agent + session storage (`internal/core/slug.go`, `agents.go`)
The top-left name is a persistent, workspace-scoped AGENT identity; each
agent owns a run of pi sessions:

```
<workspace>/.coconut/agents/<agent-slug>/sessions/<timestamp>_<uuid>.jsonl
```

The slug derives from the agent name (`Frontend Agent` → `frontend-agent`).
`state.json` tracks, per workspace: `lastAgent` + `agents[slug] = {name,
pendingSlug, lastSessionFile}` (with v1/v2 migration on load). Renames
update the live session via `set_session_name` immediately; the directory
move is deferred to the next sidecar launch (`pendingSlug`, applied by
`applyPendingRename`, which re-keys the map) because pi caches the
transcript's absolute path — a mid-session move risks compaction splitting
the transcript. Legacy transcripts outside the workspace are adopted (moved
in) at launch; the pre-agents `.coconut/sessions/<slug>/` layout migrates
into `agents/<slug>/sessions/` on scan. `.coconut/.gitignore` (`*`) keeps
transcripts out of accidental commits.

`scanAgentsLocked` (`agents.go`) inventories the workspace for the picker:
per agent, sessions newest-first with start time (from the `session` header
line), preview (first user message), size, and current markers. Abandoned
empty launch transcripts (pi creates one per process start, then
`switch_session` walks away) are hidden. Agent display names resolve:
state.json → newest session's `session_info.name` → humanized slug.

### Settings (`internal/core/settings.go`)
`settings.yaml` is user-editable YAML. Backend owns parsing and validation:
- Unknown top-level keys rejected (strict YAML).
- Provider config (`providers:`) translated to pi's `models.json`.
- Built-in provider API keys sent via env, not files.
- `COCONUT_BASH_WHITELIST` adds extra whitelist prefixes.
- Errors block saving; warnings are informational.

### Diff (`internal/core/diff.go`)
- `applyEdits` — exact-match replacements, first-occurrence-wins, sequential.
- `buildUnifiedDiff` — renders `--- a/file` / `+++ b/file` headers,
  `@@ proposed changes @@` hunk, 3 lines context, `…` elisions.

### Protocol (`internal/protocol/protocol.go`)
Go types shared between backend and (manually mirrored to) frontend.
See Protocol conventions above.

### Pi adapter (`internal/piadapter/piadapter.go`)
JSONL RPC client. Owns process lifecycle, command/response correlation
(by `id`), and raw event stream. Deliberately knows nothing about coconut's
domain — normalization lives in `internal/core`.

---

## Frontend architecture

### BackendClient (`frontend/src/backend.ts`)
Wires Wails bindings:
- `command(name, payload)` → `window.go.main.App.Command`
- `requestSnapshot()` → `window.go.main.App.RequestSnapshot`
- `onMessage(handler)` → `window.runtime.EventsOn("backend", ...)`

### UIStore (`frontend/src/store.ts`)
Framework-free store with a React binding via `useSyncExternalStore`.
- `applyBackendMessage(msg)` — dispatches to `applySnapshot`, `applyEvent`,
  or `bufferStream`.
- `applyEvent` — seq-gap detection → `resync()`; otherwise applies to state.
- `bufferStream` / `applyStream` — buffers streams in a `Map`, flushes via
  `requestAnimationFrame`, applies cumulative payloads.
- Does NOT own domain truth; derives UI state from backend messages.

### App.tsx (`frontend/src/App.tsx`)
Bootstrapper:
1. Connects to backend (buffers events until snapshot lands).
2. Sends `session.restore`.
3. Gets initial snapshot.
4. Flushes buffered events.

**No "booted" ref guard** — React StrictMode in dev intentionally remounts
effects. Cleanup must fully undo setup; setup must be safe to run twice.

### Components (`frontend/src/components/`)
- **Header.tsx** — agent name (rename), agents/sessions picker button, new-session button, workspace picker, settings gear.
- **AgentPicker.tsx** — agent/session browser modal: agents left, sessions right, new-agent + new-session actions.
- **Chat.tsx** — message list with streaming text; prompt input.
- **ToolLog.tsx** — tool call timeline (started/completed/pending_approval).
- **ContentPanel.tsx** — approval view (What/Why/Diff + Approve/Deny) or
  content doc preview (Markdown). `ApprovalView` has branches per approval kind.
- **SettingsModal.tsx** — raw YAML editor with live validation (debounced),
  errors block save, warnings are informational.
- **ColumnGrid.tsx** — resizable layout for tool log | chat | content.
- **Markdown.tsx** — react-markdown renderer for content docs.

---

## Testing

```bash
go test ./...                       # Go unit + fakepi integration
cd frontend && npx vitest run       # UI store tests
```

- Go tests live alongside their code (`*_test.go`).
- `internal/core/engine_test.go` exercises the full backend pipeline using
  fakepi: workspace set → prompt → streaming → approval → completion →
  snapshot verification. Also tests sequence monotonicity.
- Frontend store tests (`frontend/src/store.test.ts`) use Vitest and verify
  snapshot application, event ordering, seq-gap recovery, stream coalescing,
  and approval state transitions.
- `testdata/scenarios/*.json` drive fakepi for integration scenarios.

### Writing a fakepi scenario
See `cmd/fakepi/README.md`. The approval wire contract:
1. pi emits `tool_execution_start` → `extension_ui_request` (title
   `coconut://propose_edit` / `coconut://bash`, message is a JSON **string**)
2. Client answers `extension_ui_response` (`confirmed: true` or
   `cancelled: true`)
3. pi emits `tool_execution_end`

Scenario steps: `waitFor` (block on command match), `emit` (write event),
`waitForResponse` (block on approval response), `emitIf` (conditional emit
by response). Steps execute concurrently with command dispatch.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `COCONUT_PI_BINARY` | Override the sidecar binary path (dev/fakepi) |
| `COCONUT_PI_SCENARIO` | Path to a fakepi scenario JSON |
| `COCONUT_CONFIG_DIR` | Override the app config directory |
| `COCONUT_EXTENSION` | Override the pi extension path |
| `COCONUT_BASH_WHITELIST` | Extra comma-separated bash whitelist prefixes |
| `PI_CODING_AGENT_DIR` | Set by backend — isolated pi config dir |
| `PI_SKIP_VERSION_CHECK` | Set by backend |
| `PI_TELEMETRY` | Set by backend |

---

## Building and packaging

```bash
# Frontend build (needed before Go embed)
cd frontend && bun run build

# macOS package (self-contained app bundle)
scripts/package.sh
open build/bin/coconut.app
```

The packaged app bundles: the Go binary, the embedded `frontend/dist`,
the pi sidecar (single ~70MB binary in `build/sidecar/`), and the
coconut extension (`pi-extension/coconut.ts`).

---

## Style notes

- **Go**: standard formatting (`gofmt`/`goimports`). Actor-only state
  (`domainState` in `state.go`) accessed without locks. Public methods that
  send to `inbox` are safe from any goroutine.
- **TypeScript/React**: Tailwind for styling. Components use `useUIState`
  selectors — never subscribe to raw backend events as state sources.
  The `protocol.ts` is a **manual mirror** of `internal/protocol/protocol.go`;
  when you add a constant or type in one, update the other.
- **protocol.ts** is a **manual mirror** of `internal/protocol/protocol.go`.
  When you add a constant or type in one, update the other.