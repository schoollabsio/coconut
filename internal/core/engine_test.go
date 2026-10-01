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

	"github.com/jschool/coconut/internal/protocol"
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

func assertSnapshotTimelineSeqs(t *testing.T, snap protocol.Snapshot) {
	t.Helper()
	msgs := snap.State.Agent.Messages
	calls := snap.State.Agent.ToolCalls
	for i := range msgs {
		if msgs[i].Seq <= 0 {
			t.Fatalf("message %d has no seq: %+v", i, msgs[i])
		}
		if i > 0 && msgs[i].Seq <= msgs[i-1].Seq {
			t.Fatalf("messages not strictly increasing: %+v then %+v", msgs[i-1], msgs[i])
		}
	}
	for i := range calls {
		if calls[i].Seq <= 0 {
			t.Fatalf("tool call %d has no seq: %+v", i, calls[i])
		}
		if i > 0 && calls[i].Seq <= calls[i-1].Seq {
			t.Fatalf("tool calls not strictly increasing: %+v then %+v", calls[i-1], calls[i])
		}
		if len(msgs) == 0 {
			continue
		}
		var prevMsg *protocol.ChatMessage
		var nextMsg *protocol.ChatMessage
		for j := range msgs {
			if msgs[j].Seq < calls[i].Seq {
				prevMsg = &msgs[j]
				continue
			}
			if msgs[j].Seq > calls[i].Seq {
				nextMsg = &msgs[j]
				break
			}
		}
		if prevMsg == nil || nextMsg == nil {
			t.Fatalf("tool call %q seq %d is not interleaved between messages: prev=%v next=%v", calls[i].ID, calls[i].Seq, prevMsg, nextMsg)
		}
	}
}

func TestResequenceRestoredTimelineInterleavesToolCalls(t *testing.T) {
	s := newDomainState()
	// User messages get seqs, but tool-call groups are attached only to
	// the k-th assistant turn that produced them.
	s.messages = []protocol.ChatMessage{
		{ID: "m1", Role: "user", Text: "one"},
		{ID: "m2", Role: "assistant", Text: "two"},
		{ID: "m3", Role: "assistant", Text: "three"},
	}
	s.restoredToolCalls = []restoredToolCall{
		{call: protocol.ToolCall{ID: "t1", Tool: "read"}, messageOrdinal: 1},
		{call: protocol.ToolCall{ID: "t2", Tool: "write"}, messageOrdinal: 1},
		{call: protocol.ToolCall{ID: "t3", Tool: "show_content"}, messageOrdinal: 2},
		{call: protocol.ToolCall{ID: "orph", Tool: "read"}, messageOrdinal: 0},
	}

	s.resequenceRestoredTimeline()

	wantSeq := map[string]int64{
		"m1":   1,
		"m2":   2,
		"t1":   3,
		"t2":   4,
		"m3":   5,
		"t3":   6,
		"orph": 7,
	}
	for _, m := range s.messages {
		if got := m.Seq; got != wantSeq[m.ID] {
			t.Fatalf("message %s seq = %d, want %d", m.ID, got, wantSeq[m.ID])
		}
	}
	for _, tc := range s.toolCalls {
		if got := tc.Seq; got != wantSeq[tc.ID] {
			t.Fatalf("tool call %s seq = %d, want %d", tc.ID, got, wantSeq[tc.ID])
		}
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

	t.Setenv("COCONUT_PI_BINARY", fakepi)
	t.Setenv("COCONUT_PI_SCENARIO", scenario)

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

	// Snapshot mid-stream: the synthesized assistant message must get the
	// next seq so the conversation stays chronologically ordered even
	// before message_end lands.
	var streamingSnap protocol.Snapshot
	if err := json.Unmarshal(engine.RequestSnapshot(), &streamingSnap); err != nil {
		t.Fatalf("mid-stream snapshot: %v", err)
	}
	if len(streamingSnap.State.Agent.Messages) < 2 {
		t.Fatalf("mid-stream snapshot missing assistant stream: %+v", streamingSnap.State.Agent.Messages)
	}
	last := streamingSnap.State.Agent.Messages[len(streamingSnap.State.Agent.Messages)-1]
	if !last.Streaming {
		t.Fatalf("mid-stream snapshot did not synthesize streaming message: %+v", streamingSnap.State.Agent.Messages)
	}
	if last.Seq <= streamingSnap.State.Agent.Messages[len(streamingSnap.State.Agent.Messages)-2].Seq {
		t.Fatalf("streaming snapshot seq order broken: %+v", streamingSnap.State.Agent.Messages)
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
	if appr.ToolCallID == "" {
		t.Fatalf("approval request missing toolCallId: %+v", appr)
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
	assertSnapshotTimelineSeqs(t, snap)
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
	t.Setenv("COCONUT_PI_BINARY", fakepi)
	t.Setenv("COCONUT_PI_SCENARIO", scenario)

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

	t.Setenv("COCONUT_PI_BINARY", fakepi)
	t.Setenv("COCONUT_PI_SCENARIO", scenario)

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

// TestSessionRestoresToolCalls verifies that when an engine restarts on
// the same workspace, tool call history and the most recent show_content
// content doc are reconstructed from the pi transcript JSONL file.
func TestSessionRestoresToolCalls(t *testing.T) {
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

	t.Setenv("COCONUT_PI_BINARY", fakepi)
	t.Setenv("COCONUT_PI_SCENARIO", scenario)

	waitToolCalls := func(snap protocol.Snapshot) bool {
		var sawRead, sawPropose, sawShowContent, sawGroupLabel bool
		for _, tc := range snap.State.Agent.ToolCalls {
			if tc.Tool == "read" && tc.Status == protocol.ToolDone {
				sawRead = true
			}
			if tc.Tool == "propose_edit" && tc.Status == protocol.ToolDone {
				sawPropose = true
			}
			if tc.Tool == "show_content" && tc.Status == protocol.ToolDone {
				sawShowContent = true
			}
			if tc.GroupLabel != "" && tc.Status == protocol.ToolDone {
				sawGroupLabel = true
			}
		}
		return sawRead && sawPropose && sawShowContent && sawGroupLabel
	}

	// approveAndWait runs a prompt → approval → approve → completed cycle.
	// seenApprovals tracks IDs already responded to so waitFor skips stale
	// approval.requested events from earlier turns.
	seenApprovals := map[string]bool{}
	approveAndWait := func(c *envelopeCollector, e *Engine, prompt string, t *testing.T) {
		t.Helper()
		resp := sendCommand(t, e, protocol.CmdAgentStart, map[string]any{"prompt": prompt})
		if !resp.OK {
			t.Fatalf("agent.start: %+v", resp.Error)
		}
		apl, ok := c.waitFor(t, 10*time.Second, "approval", func(envType, name string, p json.RawMessage) bool {
			if envType != "event" || name != protocol.EvApprovalRequested {
				return false
			}
			var apr protocol.ApprovalRequest
			if err := json.Unmarshal(p, &apr); err != nil {
				return false
			}
			return !seenApprovals[apr.ID]
		})
		if !ok {
			t.Fatal("approval.requested never emitted")
		}
		var apr protocol.ApprovalRequest
		if err := json.Unmarshal(apl, &apr); err != nil {
			t.Fatalf("approval payload: %v", err)
		}
		seenApprovals[apr.ID] = true
		resp = sendCommand(t, e, protocol.CmdApprovalRespond, map[string]any{
			"approvalId": apr.ID,
			"decision":   protocol.DecisionAllow,
		})
		if !resp.OK {
			t.Fatalf("approval.respond: %+v", resp.Error)
		}
		if _, ok := c.waitFor(t, 10*time.Second, "completed", isEvent(protocol.EvAgentCompleted)); !ok {
			t.Fatal("agent.completed never emitted")
		}
	}

	// ---- Phase 1: run the scenario, verify tool calls + content ----
	c1 := &envelopeCollector{}
	engine1, err := NewEngine(EngineConfig{ConfigDir: configDir, Emit: c1.emit})
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	go engine1.Run(ctx1)

	resp := sendCommand(t, engine1, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set: %+v", resp.Error)
	}
	if _, ok := c1.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted (phase 1)")
	}

	// Turn 1: delete button fix.
	approveAndWait(c1, engine1, "The delete button in my todo app isn't doing anything", t)
	// Turn 2: mark-todo-complete + show_content.
	approveAndWait(c1, engine1, "mark complete", t)

	var snap1 protocol.Snapshot
	if err := json.Unmarshal(engine1.RequestSnapshot(), &snap1); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !waitToolCalls(snap1) {
		t.Fatalf("phase 1: missing tool calls: %+v", snap1.State.Agent.ToolCalls)
	}
	assertSnapshotTimelineSeqs(t, snap1)
	if snap1.State.Content == nil || snap1.State.Content.Path != "content.md" || snap1.State.Content.Content == "" {
		t.Fatalf("phase 1: missing content doc: %+v", snap1.State.Content)
	}

	// Shut down the first engine — keep workspace + config on disk.
	engine1.Shutdown()

	// ---- Phase 2: restart, verify restoration ----
	c2 := &envelopeCollector{}
	engine2, err := NewEngine(EngineConfig{ConfigDir: configDir, Emit: c2.emit})
	if err != nil {
		t.Fatalf("NewEngine (restart): %v", err)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	defer engine2.Shutdown()
	go engine2.Run(ctx2)

	resp = sendCommand(t, engine2, protocol.CmdSessionRestore, map[string]any{})
	if !resp.OK {
		t.Fatalf("session.restore: %+v", resp.Error)
	}
	if _, ok := c2.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("session.restored never emitted (phase 2)")
	}

	var snap2 protocol.Snapshot
	if err := json.Unmarshal(engine2.RequestSnapshot(), &snap2); err != nil {
		t.Fatalf("snapshot (restart): %v", err)
	}
	if snap2.State.Workspace.Path != workspace {
		t.Fatalf("workspace = %q, want %q", snap2.State.Workspace.Path, workspace)
	}
	if !waitToolCalls(snap2) {
		t.Fatalf("phase 2: tool calls not restored: %+v", snap2.State.Agent.ToolCalls)
	}
	assertSnapshotTimelineSeqs(t, snap2)
	if snap2.State.Content == nil || snap2.State.Content.Path != "content.md" || snap2.State.Content.Content == "" {
		t.Fatalf("phase 2: content not restored: %+v", snap2.State.Content)
	}
}

// TestBootSpecTwoEngines is the Phase 2 core guarantee: a window booted for
// a specific agent (BootSpec via session.restore) runs independently of
// another engine on the same workspace, each with its own seq space and
// event sink.
func TestBootSpecTwoEngines(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	fakepi := buildFakepi(t)
	scenario, err := filepath.Abs("../../testdata/scenarios/todo-app.json")
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()

	t.Setenv("COCONUT_PI_BINARY", fakepi)
	t.Setenv("COCONUT_PI_SCENARIO", scenario)

	// Engine A: the "main window" — plain workspace.set bootstrap.
	collectorA := &envelopeCollector{}
	engineA, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collectorA.emit})
	if err != nil {
		t.Fatalf("NewEngine A: %v", err)
	}
	defer engineA.Shutdown()
	go engineA.Run(context.Background())

	resp := sendCommand(t, engineA, protocol.CmdWorkspaceSet, map[string]any{"path": workspace})
	if !resp.OK {
		t.Fatalf("workspace.set (A): %+v", resp.Error)
	}
	if _, ok := collectorA.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("A: session.restored never emitted")
	}

	// Engine B: the "new window" — booted for agent "beta" in the same
	// workspace. session.restore must consume the BootSpec.
	collectorB := &envelopeCollector{}
	engineB, err := NewEngine(EngineConfig{
		ConfigDir: t.TempDir(),
		Emit:      collectorB.emit,
		Boot: &BootSpec{
			WorkspacePath: workspace,
			AgentSlug:     "beta",
			AgentName:     "Beta Agent",
		},
	})
	if err != nil {
		t.Fatalf("NewEngine B: %v", err)
	}
	defer engineB.Shutdown()
	go engineB.Run(context.Background())

	resp = sendCommand(t, engineB, protocol.CmdSessionRestore, map[string]any{})
	if !resp.OK {
		t.Fatalf("session.restore (B): %+v", resp.Error)
	}
	if _, ok := collectorB.waitFor(t, 10*time.Second, "session.restored", isEvent(protocol.EvSessionRestored)); !ok {
		t.Fatal("B: session.restored never emitted (boot spec not consumed?)")
	}

	// B landed on the boot target.
	var snapB protocol.Snapshot
	if err := json.Unmarshal(engineB.RequestSnapshot(), &snapB); err != nil {
		t.Fatalf("snapshot B: %v", err)
	}
	if snapB.State.Workspace.Path != workspace {
		t.Fatalf("B workspace = %q, want %q", snapB.State.Workspace.Path, workspace)
	}
	if snapB.State.AgentSlug != "beta" {
		t.Fatalf("B agent slug = %q, want beta", snapB.State.AgentSlug)
	}
	if snapB.State.AgentName != "Beta Agent" {
		t.Fatalf("B agent name = %q, want \"Beta Agent\"", snapB.State.AgentName)
	}

	// Independence: drive a full turn on B while A idles; B's events must
	// not leak into A's sink.
	resp = sendCommand(t, engineB, protocol.CmdAgentStart, map[string]any{"prompt": "the delete button is broken"})
	if !resp.OK {
		t.Fatalf("agent.start (B): %+v", resp.Error)
	}
	if _, ok := collectorB.waitFor(t, 10*time.Second, "approval", isEvent(protocol.EvApprovalRequested)); !ok {
		t.Fatal("B: approval never requested")
	}
	collectorB.mu.Lock()
	var bSawApproval bool
	for _, raw := range collectorB.envs {
		var head struct{ Type, Name string }
		_ = json.Unmarshal(raw, &head)
		if head.Type == "event" && head.Name == protocol.EvApprovalRequested {
			bSawApproval = true
		}
	}
	collectorB.mu.Unlock()
	if !bSawApproval {
		t.Fatal("B: approval event missing from B's sink")
	}
	collectorA.mu.Lock()
	var aSawApproval bool
	for _, raw := range collectorA.envs {
		var head struct{ Type, Name string }
		_ = json.Unmarshal(raw, &head)
		if head.Type == "event" && head.Name == protocol.EvApprovalRequested {
			aSawApproval = true
		}
	}
	collectorA.mu.Unlock()
	if aSawApproval {
		t.Fatal("event leak: A's sink saw B's approval event")
	}

	// B's seq space is independent: starts at 1, not after A's.
	collectorB.mu.Lock()
	var firstSeq uint64
	for _, raw := range collectorB.envs {
		var head struct {
			Type string `json:"type"`
			Seq  uint64 `json:"seq"`
		}
		_ = json.Unmarshal(raw, &head)
		if head.Type == "event" && (firstSeq == 0 || head.Seq < firstSeq) {
			firstSeq = head.Seq
		}
	}
	collectorB.mu.Unlock()
	if firstSeq != 1 {
		t.Fatalf("B first seq = %d, want 1 (seq spaces must be per-engine)", firstSeq)
	}
}
