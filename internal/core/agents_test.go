package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jschool/custard/internal/protocol"
)

// unmarshalPayload re-decodes a CommandResponse's generic payload.
func unmarshalPayload(t *testing.T, resp protocol.CommandResponse, v any) {
	t.Helper()
	raw, err := json.Marshal(resp.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("payload shape: %v (%s)", err, raw)
	}
}

// writeFakeSession creates a pi-v3-style transcript fixture.
func writeFakeSession(t *testing.T, path, name, firstUserMsg string, withMessages bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","version":3,"id":"x","timestamp":"2026-08-31T02:11:07.454Z","cwd":"/ws"}` + "\n" +
		`{"type":"session_info","id":"1","timestamp":"2026-08-31T02:11:07.454Z","name":"` + name + `"}` + "\n"
	if withMessages {
		content += `{"type":"message","id":"2","timestamp":"2026-08-31T02:11:13.013Z","message":{"role":"user","content":[{"type":"text","text":"` + firstUserMsg + `"}]}}` + "\n" +
			`{"type":"message","id":"3","timestamp":"2026-08-31T02:11:14.013Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}` + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanAgents(t *testing.T) {
	workspace := t.TempDir()

	// Agent "frontend": two real sessions + one abandoned empty launch file.
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "frontend"), "a.jsonl"), "Frontend", "fix the button", true)
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "frontend"), "b.jsonl"), "Frontend", "add a test", true)
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "frontend"), "empty.jsonl"), "Frontend", "", false)

	// Legacy pre-agents layout migrates into agents/ on scan.
	writeFakeSession(t, filepath.Join(workspace, ".custard", "sessions", "legacy-bot", "old.jsonl"), "Legacy Bot", "hello from the past", true)

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = workspace
	engine.state.app.WorkspacePath = workspace
	// Mark frontend as the workspace's last agent with a known transcript.
	ws := engine.state.app.ws(workspace)
	ws.LastAgent = "frontend"
	ws.agent("frontend").LastSessionFile = filepath.Join(sessionsDirFor(workspace, "frontend"), "a.jsonl")

	agents := engine.scanAgentsLocked()
	if len(agents) != 2 {
		t.Fatalf("expected 2 agents (frontend + migrated legacy-bot), got %d: %+v", len(agents), agents)
	}

	front := agents[0] // current first
	if front.Slug != "frontend" || !front.Current || front.Name != "Frontend" {
		t.Fatalf("frontend summary wrong: %+v", front)
	}
	if len(front.Sessions) != 2 {
		t.Fatalf("empty session should be hidden, got %d sessions", len(front.Sessions))
	}
	if !front.Sessions[0].Current && !front.Sessions[1].Current {
		t.Fatal("recorded last session should be marked current")
	}
	if front.Sessions[0].Preview == "" || front.Sessions[0].StartedAt == "" {
		t.Fatalf("session missing preview/startedAt: %+v", front.Sessions[0])
	}

	legacy := agents[1]
	if legacy.Slug != "legacy-bot" || legacy.Name != "Legacy Bot" || len(legacy.Sessions) != 1 {
		t.Fatalf("legacy migration wrong: %+v", legacy)
	}
	if dirExists(filepath.Join(workspace, ".custard", "sessions")) {
		t.Fatal("legacy sessions root should be gone after migration")
	}
	if legacy.Sessions[0].Preview != "hello from the past" {
		t.Fatalf("preview = %q", legacy.Sessions[0].Preview)
	}
}

// workspace.set on a workspace WITH agents must not auto-start the sidecar;
// the frontend picks via agent.open.
func TestWorkspaceSetNeedsPick(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	fakepi := buildFakepi(t)
	workspace := t.TempDir()
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "primary"), "a.jsonl"), "Primary", "earlier work", true)

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", "")

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set failed: %+v", resp.Error)
	}
	var payload struct {
		NeedsPick bool                    `json:"needsPick"`
		Agents    []protocol.AgentSummary `json:"agents"`
	}
	unmarshalPayload(t, resp, &payload)
	if !payload.NeedsPick || len(payload.Agents) != 1 || payload.Agents[0].Slug != "primary" {
		t.Fatalf("expected needsPick with primary agent: %+v", payload)
	}
	if engine.piUp {
		t.Fatal("sidecar must not auto-start when agents exist")
	}

	// Opening the agent starts the sidecar and restores its session.
	resp = sendCommand(t, engine, protocol.CmdAgentOpen, map[string]any{"slug": "primary"})
	if !resp.OK {
		t.Fatalf("agent.open failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted")
	}
	agent := engine.state.app.ws(workspace).agent("primary")
	if agent.LastSessionFile == "" {
		t.Fatal("last session file not tracked after open")
	}
}

// agent.reset starts a new underlying pi session in place.
func TestAgentResetFlow(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	fakepi := buildFakepi(t)
	workspace := t.TempDir()

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", "")

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	// Fresh workspace → auto-starts the default agent.
	resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted")
	}
	before := engine.state.app.ws(workspace).agent("primary").LastSessionFile
	if before != "/fakepi/session-1.jsonl" {
		t.Fatalf("unexpected initial session file: %q", before)
	}

	resp = sendCommand(t, engine, protocol.CmdAgentReset, nil)
	if !resp.OK {
		t.Fatalf("agent.reset failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "agent.session.reset", isEvent(protocol.EvAgentReset)); !ok {
		t.Fatal("agent.session.reset never emitted")
	}
	after := engine.state.app.ws(workspace).agent("primary").LastSessionFile
	if after != "/fakepi/session-2.jsonl" {
		t.Fatalf("session file did not advance: %q", after)
	}
}

// Renaming an agent updates the live session (set_session_name) and defers
// the directory move to the next launch, where it re-keys the agent.
func TestAgentRenameDefersAndApplies(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	fakepi := buildFakepi(t)
	workspace := t.TempDir()

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", "")

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted")
	}

	resp = sendCommand(t, engine, protocol.CmdAgentRename, map[string]any{"name": "Backend Bot"})
	if !resp.OK {
		t.Fatalf("agent.rename failed: %+v", resp.Error)
	}
	ws := engine.state.app.ws(workspace)
	agent := ws.Agents["primary"]
	if agent == nil || agent.Name != "Backend Bot" || agent.PendingSlug != "backend-bot" {
		t.Fatalf("rename not staged: %+v", ws.Agents)
	}
	if engine.state.agentName != "Backend Bot" {
		t.Fatalf("runtime name not updated: %q", engine.state.agentName)
	}

	// Simulate next launch: stop, then start again → deferred move applies.
	engine.stopSidecarLocked()
	engine.startSidecarLocked("primary", "", false, func(err error) {})
	deadline := time.Now().Add(10 * time.Second)
	for engine.state.agentSlug == "primary" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if engine.state.agentSlug != "backend-bot" {
		t.Fatalf("agent not re-keyed: %q", engine.state.agentSlug)
	}
	if ws.Agents["backend-bot"] == nil || ws.Agents["primary"] != nil {
		t.Fatalf("map not re-keyed: %+v", ws.Agents)
	}
	if ws.LastAgent != "backend-bot" {
		t.Fatalf("lastAgent not updated: %q", ws.LastAgent)
	}
}

// agent.open by NAME creates a new agent (slug derived server-side).
func TestAgentOpenByName(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	fakepi := buildFakepi(t)
	workspace := t.TempDir()

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", "")

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted")
	}

	resp := sendCommand(t, engine, protocol.CmdAgentOpen, map[string]any{"name": "Frontend Agent", "new": true})
	if !resp.OK {
		t.Fatalf("agent.open by name failed: %+v", resp.Error)
	}
	if engine.state.agentSlug != "frontend-agent" || engine.state.agentName != "Frontend Agent" {
		t.Fatalf("new agent wrong: slug=%q name=%q", engine.state.agentSlug, engine.state.agentName)
	}
	if !dirExists(sessionsDirFor(workspace, "frontend-agent")) {
		t.Fatal("new agent sessions dir not created")
	}
}
