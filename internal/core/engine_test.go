package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jschool/custard/internal/protocol"
)

// envelopeCollector captures everything the engine emits.
type envelopeCollector struct {
	mu   sync.Mutex
	envs []json.RawMessage
}

func (c *envelopeCollector) emit(env any) {
	b, _ := json.Marshal(env)
	c.mu.Lock()
	c.envs = append(c.envs, b)
	c.mu.Unlock()
}

func (c *envelopeCollector) find(t *testing.T, pred func(envType, name string, payload json.RawMessage) bool) (name string, payload json.RawMessage, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, raw := range c.envs {
		var head struct {
			Type    string          `json:"type"`
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			continue
		}
		if pred(head.Type, head.Name, head.Payload) {
			return head.Name, head.Payload, true
		}
	}
	return "", nil, false
}

func (c *envelopeCollector) waitFor(t *testing.T, timeout time.Duration, what string, pred func(envType, name string, payload json.RawMessage) bool) (json.RawMessage, bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, payload, ok := c.find(t, pred); ok {
			return payload, true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, false
}

func isEvent(name string) func(string, string, json.RawMessage) bool {
	return func(envType, n string, _ json.RawMessage) bool {
		return envType == "event" && n == name
	}
}

// buildFakepi compiles cmd/fakepi into a temp binary.
func buildFakepi(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fakepi-test")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/fakepi")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build fakepi: %v", err)
	}
	return bin
}

func sendCommand(t *testing.T, e *Engine, name string, payload any) protocol.CommandResponse {
	t.Helper()
	req := map[string]any{"type": "command", "id": "t-" + name, "name": name, "payload": payload}
	raw, _ := json.Marshal(req)
	respBytes := e.HandleCommand(raw)
	var resp protocol.CommandResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		t.Fatalf("response not JSON: %v (%s)", err, respBytes)
	}
	return resp
}

// TestEngineAgainstFakepi drives the full backend pipeline: workspace
// set → prompt → streaming → approval → completion → snapshot.
func TestEngineAgainstFakepi(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	fakepi := buildFakepi(t)
	scenario, err := filepath.Abs("../../testdata/scenarios/todo-app.json")
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	configDir := t.TempDir()

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", scenario)

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{
		ConfigDir: configDir,
		Emit:      collector.emit,
	})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	// 1. workspace.set starts the sidecar.
	resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted")
	}

	// 2. agent.start streams a reply and ends in an approval request.
	resp = sendCommand(t, engine, protocol.CmdAgentStart, map[string]any{"prompt": "The delete button in my todo app isn't doing anything"})
	if !resp.OK {
		t.Fatalf("agent.start failed: %+v", resp.Error)
	}

	// Token stream should carry cumulative text.
	if _, ok := collector.waitFor(t, 10*time.Second, "agent.token", func(envType, name string, p json.RawMessage) bool {
		if envType != "stream" || name != protocol.StreamAgentToken {
			return false
		}
		var tp protocol.TokenPayload
		_ = json.Unmarshal(p, &tp)
		return tp.Text != ""
	}); !ok {
		t.Fatal("no token stream observed")
	}

	// Approval request for the propose_edit, with a computed diff.
	apprPayload, ok := collector.waitFor(t, 10*time.Second, "approval.requested", isEvent(protocol.EvApprovalRequested))
	if !ok {
		t.Fatal("agent.approval.requested never emitted")
	}
	var appr protocol.ApprovalRequest
	if err := json.Unmarshal(apprPayload, &appr); err != nil {
		t.Fatalf("approval payload: %v", err)
	}
	if appr.Kind != protocol.ApprovalKindProposeEdit || appr.Path == "" || appr.What == "" || appr.Diff == "" {
		t.Fatalf("incomplete approval request: %+v", appr)
	}

	// 3. Approve it; the run completes.
	resp = sendCommand(t, engine, protocol.CmdApprovalRespond, map[string]any{
		"approvalId": appr.ID,
		"decision":   protocol.DecisionAllow,
	})
	if !resp.OK {
		t.Fatalf("approval.respond failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "agent.completed", isEvent(protocol.EvAgentCompleted)); !ok {
		t.Fatal("agent.completed never emitted")
	}

	// 4. Snapshot reflects final state.
	var snap protocol.Snapshot
	if err := json.Unmarshal(engine.RequestSnapshot(), &snap); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snap.State.Workspace.Path != workspace {
		t.Errorf("snapshot workspace = %q", snap.State.Workspace.Path)
	}
	if snap.State.Agent.Status != protocol.StatusIdle {
		t.Errorf("snapshot status = %q", snap.State.Agent.Status)
	}
	if len(snap.State.PendingApprovals) != 0 {
		t.Errorf("pending approvals not cleared: %+v", snap.State.PendingApprovals)
	}
	var sawUser, sawAssistant bool
	for _, m := range snap.State.Agent.Messages {
		if m.Role == "user" {
			sawUser = true
		}
		if m.Role == "assistant" && m.Text != "" {
			sawAssistant = true
		}
	}
	if !sawUser || !sawAssistant {
		t.Errorf("snapshot messages incomplete: %+v", snap.State.Agent.Messages)
	}
	var sawProposeDone bool
	for _, tc := range snap.State.Agent.ToolCalls {
		if tc.Tool == "propose_edit" && tc.Status == protocol.ToolDone {
			sawProposeDone = true
		}
	}
	if !sawProposeDone {
		t.Errorf("propose_edit tool call not done: %+v", snap.State.Agent.ToolCalls)
	}
}

// TestSequenceMonotonic verifies global seq ordering across events.
func TestSequenceMonotonic(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	fakepi := buildFakepi(t)
	scenario, _ := filepath.Abs("../../testdata/scenarios/todo-app.json")
	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", scenario)

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	resp := sendCommand(t, engine, protocol.CmdWorkspaceSet, map[string]any{"path": t.TempDir()})
	if !resp.OK {
		t.Fatalf("workspace.set: %+v", resp.Error)
	}
	sendCommand(t, engine, protocol.CmdAgentStart, map[string]any{"prompt": "delete button"})
	collector.waitFor(t, 10*time.Second, "approval", isEvent(protocol.EvApprovalRequested))

	collector.mu.Lock()
	defer collector.mu.Unlock()
	var last uint64
	for _, raw := range collector.envs {
		var head struct {
			Type string `json:"type"`
			Seq  uint64 `json:"seq"`
			Name string `json:"name"`
		}
		_ = json.Unmarshal(raw, &head)
		if head.Type != "event" {
			continue
		}
		if head.Seq <= last {
			t.Fatalf("non-monotonic seq: %d after %d (%s)", head.Seq, last, head.Name)
		}
		last = head.Seq
	}
	fmt.Println("checked", len(collector.envs), "envelopes")
}

// TestWorkspacePickFlow drives the exact path the UI uses: workspace.pick
// (native dialog stubbed) must emit workspace.changed, start the sidecar,
// and respond — regression test for "nothing happens after picking a dir".
func TestWorkspacePickFlow(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	fakepi := buildFakepi(t)
	scenario, err := filepath.Abs("../../testdata/scenarios/todo-app.json")
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()

	t.Setenv("CUSTARD_PI_BINARY", fakepi)
	t.Setenv("CUSTARD_PI_SCENARIO", scenario)

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{
		ConfigDir: t.TempDir(),
		PickDir:   func() (string, error) { return workspace, nil },
		Emit:      collector.emit,
	})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Run(ctx)
	defer engine.Shutdown()

	resp := sendCommand(t, engine, protocol.CmdWorkspacePick, map[string]any{})
	if !resp.OK {
		t.Fatalf("workspace.pick failed: %+v", resp.Error)
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "workspace.changed", isEvent(protocol.EvWorkspaceChanged)); !ok {
		t.Fatal("workspace.changed never emitted")
	}
	if _, ok := collector.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted (sidecar never started?)")
	}

	snap := engine.RequestSnapshot()
	var sm protocol.Snapshot
	if err := json.Unmarshal(snap, &sm); err != nil {
		t.Fatal(err)
	}
	if sm.State.Workspace.Path != workspace {
		t.Fatalf("snapshot workspace = %q, want %q", sm.State.Workspace.Path, workspace)
	}
}
