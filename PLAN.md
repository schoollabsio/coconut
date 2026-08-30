# Technical Specification  
## Go-based Coding Agent Desktop Application (Custard)

## 1. Introduction

### 1.1 Purpose

This document specifies the architecture and technical design for a desktop coding agent application. The application is implemented primarily in Go, with an embedded React + HTML/CSS frontend rendered inside a native webview. A `pi` sidecar process serves as the underlying agent runtime, communicating with the Go backend over its RPC protocol.

The goal is to deliver a fully native desktop experience where:

- **Go** owns domain state and acts as the authoritative backend.
- **React** serves as the event-driven UI renderer and owns transient UI state.
- **Pi** runs as a sidecar process and provides agent execution.
- Communication between Go and React is event-driven, with explicit commands, events, and snapshots.

### 1.2 Scope

This document covers the high-level architecture, component responsibilities, communication protocols, data models, and integration points. It does not cover UI design specifics, Pi internals, or third-party LLM provider specifics.

### 1.3 Definitions

| Term         | Definition                                                                 |
|--------------|----------------------------------------------------------------------------|
| **Pi**       | The agent sidecar process that executes agent logic and tool calls.       |
| **Go backend** | The main native Go application. Owns domain state, manages Pi, and communicates with the frontend. |
| **Frontend** | The React application running in an embedded webview.                     |
| **Event**    | A fact that has occurred (e.g., `agent.tool.completed`).                  |
| **Command**  | A request to perform an action (e.g., `agent.start`).                     |
| **Snapshot** | A complete or partial state payload used for initial load or resync.      |
| **UI Store** | The in-memory, client-side state store owned by the frontend.             |

---

## 2. Architecture Overview

### 2.1 High-Level Architecture

```text
┌────────────────────────────┐
│  Pi Sidecar Process        │
│  (Agent Runtime)           │
│                            │
│  RPC Protocol              │
└────────────┬───────────────┘
             │ RPC (local)
             ▼
┌────────────────────────────┐
│  Go Backend                │
│                            │
│  - Pi Adapter              │
│  - Domain State            │
│  - Event Normalizer        │
│  - Sequencer               │
│  - Snapshot Engine         │
│  - Command Router          │
│  - Process / File / Git    │
│  - Permissions             │
└────────────┬───────────────┘
             │ WebSocket / IPC
             ▼
┌────────────────────────────┐
│  React Frontend            │
│                            │
│  - BackendClient           │
│  - EventBus                │
│  - UI Store                │
│  - React Components        │
└────────────────────────────┘
```

### 2.2 Layers

1. **Runtime Layer (Pi):** Executes agent work and emits events.
2. **Domain Layer (Go):** Owns state, coordinates Pi, normalizes events, and exposes a command/event API.
3. **Presentation Layer (React):** Renders UI and owns transient state.

---

## 3. Component Design

### 3.1 Pi Sidecar

Responsibilities:

- Execute agent logic and tool calls.
- Emit events (token streaming, tool output, approvals, completion, errors).
- Accept commands (start, cancel, approval responses).
- Persist session state where applicable.

Design constraints:

- Pi must never be accessed directly by the frontend.
- Go owns the lifecycle of the Pi process.

### 3.2 Go Backend

The Go backend is the central orchestrator and the source of truth for domain state.

#### 3.2.1 Pi Adapter

Wraps Pi’s RPC protocol.

Responsibilities:

- Start/stop the Pi sidecar process.
- Negotiate protocol version.
- Issue Pi commands and subscribe to Pi events.
- Translate Pi-specific events into normalized backend domain events.

#### 3.2.2 Domain State

Go owns:

- Agent session state (status, messages, tool calls, approvals, cost, usage).
- Filesystem metadata.
- Git repository state.
- Running processes and terminals.
- Workspace/session metadata.
- Pending approvals.

#### 3.2.3 Event Normalizer

All external inputs (Pi events, filesystem watcher events, process events, git events) are translated into a unified event schema and assigned a global, monotonically increasing sequence number.

#### 3.2.4 Sequencer

Assigns each backend-emitted event a global `seq` value. Ensures total ordering of events delivered to the frontend.

#### 3.2.5 Snapshot Engine

Provides point-in-time state snapshots.

Used for:

- Initial frontend load.
- Frontend resynchronization after disconnect/gap.
- Recovery after Pi restart.

#### 3.2.6 Command Router

Accepts commands from the frontend and dispatches them to the appropriate domain manager.

#### 3.2.7 Process / File / Git Managers

Own the lifecycle of:

- PTY/terminal processes.
- File system operations.
- Git operations (status, diff, commit, log).

Emit normalized domain events.

### 3.3 React Frontend

#### 3.3.1 BackendClient

Manages the transport (WebSocket or IPC) to Go.

Responsibilities:

- Open and maintain a connection.
- Send commands and await responses.
- Receive backend events and forward to the event bus.
- Request snapshots.
- Handle reconnection logic.

Interface:

```ts
class BackendClient {
  command(name: string, payload: unknown): Promise<CommandResponse>
  requestSnapshot(): Promise<SnapshotResponse>
  onEvent(handler: (event: BackendEvent) => void): UnsubscribeFn
}
```

#### 3.3.2 EventBus

The in-process event bus for frontend communication.

Responsibilities:

- Local UI events (`ui.tab.activated`, etc.).
- Backend event fan-out to components.
- One-off subscription for non-state events.

#### 3.3.3 UI Store

The single source of truth for UI state on the client.

Responsibilities:

- Apply backend events.
- Apply local UI events.
- Maintain the current state snapshot.
- Expose selectors to components.

Design note: the UI Store does **not** own domain truth; it derives UI-relevant state from backend events.

#### 3.3.4 React Components

Components subscribe to slices of UI Store state and send commands to the backend.

They do **not** directly subscribe to raw backend events as state sources, except for one-off notifications.

---

## 4. Data Model

### 4.1 UIState

```ts
type UIState = {
  connected: boolean
  lastBackendSeq: number

  workspace: {
    id: string
    rootPath: string
    name: string
    git: GitState
  }

  tabs: Tab[]
  activeTabId: string | null

  fileTree: FileTreeNode | null
  selectedFilePath: string | null
  docs: Record<string, DocMeta>

  agent: AgentState
  terminals: Record<string, TerminalMeta>
  activeTerminalId: string | null

  pendingApprovals: ApprovalRequest[]
  notifications: Notification[]
}
```

### 4.2 Commands

Commands are requests from frontend to backend.

```ts
type Command = {
  id: string            // unique command ID
  name: string          // command name (e.g., "agent.start")
  payload: unknown      // command payload
}
```

### 4.3 Events

Events are facts emitted by the backend or by local UI actions.

```ts
type BackendEvent = {
  seq: number            // global backend sequence number
  type: string           // event type
  payload: unknown       // event payload
  timestamp: number
  correlationId?: string // for tracing commands
}

type LocalUIEvent = {
  type: string           // e.g., "ui.tab.activated"
  payload: unknown
  timestamp: number
}
```

### 4.4 Snapshots

```ts
type SnapshotResponse = {
  type: "snapshot"
  seq: number
  state: UIStateSnapshot
}

type UIStateSnapshot = {
  workspace: WorkspaceSnapshot
  fileTree: FileTreeNode
  agent: AgentSnapstate
  tabs: Tab[]
  pendingApprovals: ApprovalRequest[]
  // Other backend-derivable state
}
```

---

## 5. Communication Protocol

### 5.1 Transport

- WebSocket over local loopback for packaged builds.
- Wails runtime events (if using Wails) or direct IPC.
- Connection is local-only; no network exposure.

### 5.2 Message Envelope

All frontend/backend messages share a base envelope:

```json
{
  "type": "<message_type>",
  "id": "<optional_id>",
  "payload": { ... },
  "correlationId": "<optional>",
  "error": null
}
```

### 5.3 Command Message

```json
{
  "type": "command",
  "id": "cmd_123",
  "name": "agent.start",
  "payload": {
    "prompt": "Fix the failing auth tests"
  }
}
```

### 5.4 Command Response

```json
{
  "type": "command_response",
  "commandId": "cmd_123",
  "ok": true
}
```

Error response:

```json
{
  "type": "command_response",
  "commandId": "cmd_123",
  "ok": false,
  "error": {
    "code": "agent_already_running",
    "message": "An agent run is already active."
  }
}
```

### 5.5 Event Message

```json
{
  "type": "event",
  "seq": 483,
  "name": "agent.status.changed",
  "correlationId": "cmd_42",
  "payload": {
    "status": "thinking"
  }
}
```

### 5.6 Snapshot Message

```json
{
  "type": "snapshot",
  "seq": 482,
  "state": {
    "agent": { ... },
    "fileTree": { ... },
    "tabs": [ ... ]
  }
}
```

### 5.7 Error Message

```json
{
  "type": "error",
  "code": "snapshot_corrupted",
  "message": "Snapshot could not be deserialized."
}
```

### 5.8 Streaming Messages

High-frequency streams are delivered as separate message types to avoid blocking state updates.

```json
{
  "type": "stream",
  "name": "agent.token",
  "payload": {
    "token": "the"
  }
}
```

---

## 6. Event & Command Catalog

### 6.1 Commands (Frontend → Backend)

| Command                   | Payload                                                                 | Description                                  |
|---------------------------|-------------------------------------------------------------------------|----------------------------------------------|
| `session.restore`         | `{}`                                                                    | Restore last session on startup.             |
| `file.open`               | `{ path: string }`                                                      | Open a file.                                 |
| `file.save`               | `{ path: string, content: string }`                                     | Save file contents.                          |
| `agent.start`             | `{ prompt: string, options?: AgentOptions }`                            | Start an agent run.                          |
| `agent.cancel`            | `{}`                                                                    | Cancel current agent run.                    |
| `agent.approval.respond`  | `{ approvalId: string, decision: "allow" | "deny" }`                   | Respond to an approval request.              |
| `terminal.create`         | `{ shell?: string }`                                                    | Create a terminal pane.                      |
| `terminal.write`          | `{ terminalId: string, data: string }`                                  | Send input to a terminal.                    |
| `terminal.close`          | `{ terminalId: string }`                                                | Close a terminal pane.                       |

### 6.2 Backend Events

| Event                    | Stream? | Correlation? | Description                                      |
|--------------------------|---------|--------------|--------------------------------------------------|
| `session.restored`       | No      | Yes          | Session restored on startup.                     |
| `file.opened`            | No      | Yes          | File was opened.                                 |
| `file.changed`           | No      | Yes          | File system change detected.                     |
| `file.tree.updated`      | No      | No           | File tree changed (patched).                     |
| `agent.started`          | No      | Yes          | Agent session started.                           |
| `agent.status.changed`   | No      | Yes          | Agent status updated.                            |
| `agent.message.appended` | No      | Yes          | New message in agent conversation.               |
| `agent.token`            | Yes     | Yes          | LLM token streamed.                              |
| `agent.tool.started`     | No      | Yes          | Tool call began.                                 |
| `agent.tool.output`      | Yes     | Yes          | Tool output streamed.                            |
| `agent.tool.completed`   | No      | Yes          | Tool call finished.                              |
| `agent.approval.requested` | No    | Yes          | Approval requested from user.                    |
| `agent.approval.resolved`| No      | Yes          | Approval resolved.                               |
| `agent.completed`        | No      | Yes          | Agent run finished.                              |
| `agent.failed`           | No      | Yes          | Agent run failed.                                |
| `process.started`        | No      | Yes          | Process started in terminal.                     |
| `process.output`         | Yes     | Yes          | Terminal process output streamed.                |
| `process.exited`         | No      | Yes          | Process exited.                                  |
| `git.status.changed`     | No      | No           | Git status updated.                              |
| `notification.created`   | No      | No           | New notification shown.                          |

### 6.3 Frontend Local UI Events

| Event                    | Description                                  |
|--------------------------|----------------------------------------------|
| `ui.tab.activated`       | Active tab changed.                          |
| `ui.file.selected`       | File selected in tree/editor.                |
| `ui.modal.opened`        | Modal opened.                                |
| `ui.modal.closed`        | Modal closed.                                |
| `ui.layout.changed`      | Window/panel layout changed.                 |
| `ui.theme.changed`       | Theme changed.                               |
| `ui.search.focus`        | Search panel focused.                        |
| `ui.panel.resized`       | Panel resized.                               |

---

## 7. Frontend Event System Design

### 7.1 EventBus

```ts
interface EventBus {
  // Local UI events only
  emit(type: string, payload: unknown): void

  // Local + backend fan-out subscription
  on(type: string, handler: EventHandler): UnsubscribeFn

  // Unsubscribe all handlers for a type (lifecycle)
  off(type: string): void
}
```

Rules:

- Local UI events do **not** carry sequence numbers.
- Backend events are delivered through the bus after being applied to the store.
- Components subscribe to **specific topics**, not wildcards.

### 7.2 Command API

```ts
class BackendAPI {
  command<T = unknown>(name: string, payload: unknown): Promise<T>
  requestSnapshot(): Promise<void>
}
```

All user-initiated actions that affect domain state go through `BackendAPI.command()`.

### 7.3 UI Store

```ts
class UIStore {
  state: UIState
  lastBackendSeq: number

  // Apply a backend event
  applyBackendEvent(event: BackendEvent): void

  // Apply a local UI event
  applyLocalEvent(event: LocalUIEvent): void

  // Selectors
  get<T>(selector: (state: UIState) => T): T

  // Subscribe to state changes
  subscribe(listener: () => void): UnsubscribeFn
}
```

React integration:

```tsx
const activeTab = useUIState((s) => s.activeTabId)
const agent = useUIState((s) => s.agent)
```

One-off subscriptions:

```tsx
useEffect(() => {
  return bus.on("agent.approval.requested", (e) => {
    // show approval UI
  })
}, [])
```

---

## 8. Backend State Management

### 8.1 Single-Writer Actor

All backend state mutations occur within a single writer goroutine.

Incoming inputs:

- Frontend commands.
- Pi event stream.
- File watcher events.
- Process lifecycle events.

These are funneled into a single `chan` and processed sequentially.

### 8.2 Event Sourcing (Optional)

The backend can optionally persist events to an event log for:

- Debugging.
- Replaying sessions.
- Testing.

This is not required for MVP but can be enabled per-session.

### 8.3 Coalescing Before Delivery

Before sending events to the frontend, the backend can coalesce batches:

- High-frequency streams (tokens, terminal output) can be batched.
- Important transitions flush immediately.

### 8.4 Sequence Numbers

Every backend-emitted event has a `seq` value, assigned at the backend.

Frontend logic:

```ts
if (event.seq === store.lastBackendSeq + 1) {
  store.applyBackendEvent(event)
} else {
  // Gap or out-of-order: request snapshot
  await backend.requestSnapshot()
}
```

### 8.5 Snapshots

On:

- Initial connect.
- Reconnect after disconnect.
- Detected sequence gap.

The backend computes a snapshot and sends:

```json
{ "type": "snapshot", "seq": N, "state": { ... } }
```

The frontend replaces local backend-derived state.

---

## 9. Pi Sidecar Protocol Integration

### 9.1 Lifecycle

1. Go starts the Pi process.
2. Go negotiates protocol version.
3. Go subscribes to Pi event streams.
4. Go forwards normalized events to the frontend.
5. Frontend commands are translated and forwarded to Pi.
6. On Pi crash, Go emits `agent.sidecar.lost`.
7. Go attempts restart or reports permanent failure.

### 9.2 Version Negotiation

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "piVersion": "v0.X.Y"
}
```

### 9.3 Command Mapping

| Frontend Command     | Pi RPC Call         |
|----------------------|---------------------|
| `agent.start`        | `StartSession`      |
| `agent.cancel`       | `CancelSession`     |
| `agent.approval.respond` | `RespondApproval` |

### 9.4 Error Codes

Pi errors are translated into backend error codes:

```text
pi_internal_error
pi_not_responding
pi_version_mismatch
```

These surface as backend events:

```json
{
  "type": "event",
  "name": "agent.failed",
  "payload": {
    "error": "pi_internal_error",
    "message": "..."
  }
}
```

---

## 10. Performance Considerations

### 10.1 Event Coalescing

Backend coalesces events before delivery:

- Batch window: 8–16ms.
- Flush immediately on important transitions.

### 10.2 High-Frequency Streams

Separate message types for streams:

- `agent.token`
- `agent.tool.output`
- `terminal.output`

Frontend can buffer these and flush via `requestAnimationFrame`.

### 10.3 Virtualized Lists

UI lists (messages, file tree, tabs) should be virtualized.

### 10.4 No Full UI State Round-Trips

UI state should not be sent to Go and back. Only domain commands and domain events cross the boundary.

---

## 11. Resilience

### 11.1 Reconnection

- Go backend reconnects to Pi if the stream drops.
- Frontend reconnects to Go if the WebSocket/IPC breaks.

### 11.2 Sequence Gap Handling

- Frontend detects gaps via `seq` numbers.
- On gap, the frontend requests a fresh snapshot.

### 11.3 Pi Crash Handling

- Go detects Pi exit.
- Go emits `agent.sidecar.lost`.
- Go attempts restart (configurable retries).
- If restart fails, emit `agent.failed`.

### 11.4 Retry Policy

- Network/transport retries use exponential backoff.
- Commands have timeouts and can be retried by the frontend if explicitly safe.

---

## 12. Security

### 12.1 Local-Only Transport

- WebSocket/IPC binds to localhost only.
- No external network exposure.

### 12.2 Command Validation

All commands entering Go are validated (types, payloads, permissions).

### 12.3 Approval System

Dangerous operations require user approval:

- Running shell commands.
- Deleting files.
- Editing files outside workspace.
- Network access from Pi.

Approvals are surfaced as backend events:

```json
{
  "type": "event",
  "name": "agent.approval.requested",
  "payload": {
    "approvalId": "approval_123",
    "title": "Delete file?",
    "description": "Agent wants to delete /path/to/file",
    "risk": "high"
  }
}
```

### 12.4 Content Security

- If HTML/CSS/JS is loaded from a local server, disable remote content.
- Apply a strict Content-Security-Policy.
- Sandbox Pi processes where possible.

---

## 13. Testing Strategy

### 13.1 Unit Testing

- UI Store reducers (pure functions applied to events).
- Pi Adapter translation logic.
- Event normalizer.
- Snapshot serialization/deserialization.

### 13.2 Contract Testing

- Recorded backend event streams replayed into frontend store tests.
- Command payloads tested for validation.

### 13.3 Integration Testing

- Mock Pi sidecar returning scripted event streams.
- Verify correct normalized backend events.
- Verify correct UI state transitions.

### 13.4 Event Log Replay

Backend can dump recorded event streams for debugging and regression testing.

---

## 14. Deployment and Packaging

### 14.1 Build Targets

- Windows (amd64, arm64)
- macOS (amd64, arm64)
- Linux (amd64, arm64)

### 14.2 Bundled Assets

- Frontend build (`dist/`) embedded via `go:embed`.
- Pi binary bundled alongside the Go binary.

### 14.3 Packaging

- Windows: MSI/installer or portable EXE.
- macOS: DMG.
- Linux: AppImage, deb, rpm, or flatpak.

### 14.4 Updates

- Backend provides an `app.update.check` command.
- Updates fetched from a signed release channel.

---

## 15. Non-Goals

This document does **not** cover:

- UI design, themes, or CSS frameworks.
- Pi internal architecture, model selection, or prompt engineering.
- Third-party LLM provider integrations.
- Mobile or web (browser) deployment.
- Plugin/extension systems.

---

## 16. Future Considerations

- **Web version**: The Go backend domain logic and shared core packages could be compiled to WASM to support a browser-based version of the frontend.
- **Plugin system**: Allow third-party tools to be registered by the frontend and proxied through Go.
- **Multi-agent orchestration**: Support multiple Pi sidecars for different agent profiles.

---

## Appendix A: Sequence Diagram (Initial Load)

```text
Frontend                   Go Backend               Pi Sidecar
   │                            │                         │
   │ connect                    │                         │
   │──────────────────────────>│                         │
   │                            │ start                   │
   │                            │────────────────────────>│
   │                            │                         │
   │ request snapshot           │                         │
   │<──────────────────────────│                         │
   │                            │                         │
   │ receive snapshot           │                         │
   │──────────────────────────>│                         │
   │ apply snapshot             │                         │
   │                            │                         │
   │ subscribe to events        │                         │
   │<──────────────────────────│                         │
```

## Appendix B: Sequence Diagram (Agent Start)

```text
Frontend                   Go Backend                  Pi Sidecar
   │                            │                         │
   │ command: agent.start       │                         │
   │──────────────────────────>│                         │
   │                            │ StartSession            │
   │                            │────────────────────────>│
   │                            │                         │
   │                            │ event: agent.started    │
   │ <──────────────────────────│                         │
   │ apply event                │                         │
   │                            │                         │
   │                            │ events: agent.token, …  │
   │ <──────────────────────────│ <─────────────────────── │
   │ apply events                │                         │
```
