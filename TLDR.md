# Coconut — TL;DR

## What is it?

Coconut is a desktop coding agent app where you chat with an AI agent, watch its tool calls live, and **approve every file edit before it lands**.

## How it works

```
┌──────────────┐   JSONL RPC   ┌───────────────┐   Wails IPC   ┌──────────┐
│ pi sidecar   │ ◄───────────► │ Go backend    │ ◄───────────► │ React UI │
│ (agent loop) │               │ (single-writer │               │          │
│ + coconut.ts │               │  actor)       │               │          │
└──────────────┘               └───────────────┘               └──────────┘
```

1. **Pi sidecar**: The `pi` agent in RPC mode with a custom extension (`coconut.ts`) that gates `propose_edit` behind approvals (bash too, with a whitelist).
2. **Go backend**: Owns domain truth, sequences events with a global `seq`, normalizes pi events, emits snapshots. Single-writer actor pattern — all state mutations on one goroutine.
3. **React frontend**: Two panes — a unified chat timeline (with streaming text, inline approvals, and tool calls) and a content panel (approvals with diffs + rendered docs).

## Key principles

- **Approval-gated editing**: `propose_edit` is the ONLY file-modification channel.
- **Go owns domain truth**: Frontend can't talk to pi directly.
- **Global sequencing**: Events sequenced via `seq`; frontend detects gaps → resync via snapshot.
- **Cumulative streams**: Token/tool output payloads are cumulative (self-healing if dropped).

## Development

```bash
# Token-free dev (uses scripted fakepi):
go build -o build/bin/fakepi ./cmd/fakepi
export COCONUT_PI_BINARY="$PWD/build/bin/fakepi"
export COCONUT_PI_SCENARIO="$PWD/testdata/scenarios/todo-app.json"
wails dev

# Real pi:
unset COCONUT_PI_BINARY COCONUT_PI_SCENARIO
wails dev

# Test
go test ./...
cd frontend && npx vitest run

# Package (macOS)
scripts/package.sh
```

## Layout

- `internal/core/` — Engine (actor loop), commands, normalize, state, sidecar lifecycle, settings, diff
- `internal/piadapter/` — JSONL RPC client + process lifecycle
- `internal/protocol/` — Shared Go↔frontend message types (manual mirror in frontend)
- `frontend/` — React + TypeScript + Vite + Tailwind
- `pi-extension/coconut.ts` — Approval-gated tools extension
- `cmd/fakepi/` — Scripted pi stand-in for testing/dev
- `testdata/scenarios/` — Fakepi scenarios