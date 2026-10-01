package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/jschool/coconut/internal/piadapter"
	"github.com/jschool/coconut/internal/protocol"
)

// feedNorm pushes raw pi events straight through the normalizer.
func feedNorm(e *Engine, typ, raw string) {
	e.normalizePiEvent(piadapter.Event{Type: typ, Raw: json.RawMessage(raw)})
}

// Tool-call-only assistant turns (message_start → toolcall updates →
// message_end with no text blocks) must not surface an empty chat bubble.
func TestToolCallOnlyTurnEmitsNoMessage(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	feedNorm(engine, "message_start", `{}`)
	feedNorm(engine, "message_update", `{"assistantMessageEvent":{"type":"toolcall_start"}}`)
	feedNorm(engine, "message_end", `{"message":{"role":"assistant","content":[{"type":"toolCall","name":"read"}]}}`)

	if got := len(engine.state.messages); got != 0 {
		t.Fatalf("expected no messages for tool-call-only turn, got %d", got)
	}
	if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
		return envType == "event" && name == protocol.EvAgentMessage
	}); ok {
		t.Fatal("agent.message emitted for an empty (tool-call-only) turn")
	}
	if engine.state.streaming {
		t.Fatal("streaming flag left set after dropped empty message")
	}

	// A subsequent text turn must still stream + finalize normally.
	feedNorm(engine, "message_start", `{}`)
	feedNorm(engine, "message_update", `{"assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	feedNorm(engine, "message_end", `{"message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}`)

	if got := len(engine.state.messages); got != 1 {
		t.Fatalf("expected 1 message after text turn, got %d", got)
	}
	if engine.state.messages[0].Text != "hello" {
		t.Fatalf("message text = %q", engine.state.messages[0].Text)
	}
}

// Whitespace-only finals are dropped the same way; real text is kept.
func TestEndStreamDropsEmptyText(t *testing.T) {
	s := &domainState{}

	s.beginStream()
	if msg := s.endStream(""); msg.ID != "" {
		t.Fatalf("empty final should be dropped, got %+v", msg)
	}
	if len(s.messages) != 0 || s.streaming {
		t.Fatal("state polluted by dropped empty message")
	}

	s.beginStream()
	if msg := s.endStream("  \n\t "); msg.ID != "" {
		t.Fatalf("whitespace-only final should be dropped, got %+v", msg)
	}
	if len(s.messages) != 0 {
		t.Fatal("whitespace-only message appended")
	}

	s.beginStream()
	msg := s.endStream("hi")
	if msg.ID == "" || len(s.messages) != 1 || s.messages[0].Text != "hi" {
		t.Fatalf("real message lost: %+v / %+v", msg, s.messages)
	}
}

// Reasoning-only turns (thinking, then tool calls with no prose) are kept
// in history so a snapshot/resync shows the same thinking block the live
// stream did; only truly contentless turns are dropped.
func TestEndStreamKeepsReasoningOnlyTurn(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	feedNorm(engine, "message_start", `{}`)
	feedNorm(engine, "message_update", `{"assistantMessageEvent":{"type":"thinking_delta","delta":"hmm"}}`)
	feedNorm(engine, "message_end", `{"message":{"role":"assistant","content":[{"type":"toolCall","name":"read"}]}}`)

	if got := len(engine.state.messages); got != 1 {
		t.Fatalf("expected reasoning-only turn to be kept, got %d messages", got)
	}
	m := engine.state.messages[0]
	if m.Thinking != "hmm" || !m.ThinkingDone || m.Text != "" {
		t.Fatalf("unexpected kept message: %+v", m)
	}
	// Live clients get the finalized message too (carries thinkingMs).
	if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
		return envType == "event" && name == protocol.EvAgentMessage
	}); !ok {
		t.Fatal("agent.message not emitted for reasoning-only turn")
	}
	// And a resyncing client sees it in the snapshot.
	snap := engine.state.snapshot()
	if len(snap.Agent.Messages) != 1 || snap.Agent.Messages[0].Thinking != "hmm" {
		t.Fatalf("snapshot lost reasoning-only turn: %+v", snap.Agent.Messages)
	}
}

// show_content is the ungated display channel: a successful tool end
// promotes the captured args into the content doc; an errored call does not.
func TestShowContentPromotion(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc1","toolName":"show_content","args":{"path":"report.md","content":"# Hi"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc1","toolName":"show_content","isError":false}`)

	if engine.state.content == nil || engine.state.content.Content != "# Hi" {
		t.Fatalf("content not promoted: %+v", engine.state.content)
	}
	if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
		return envType == "event" && name == protocol.EvContentUpdated
	}); !ok {
		t.Fatal("no content.updated event")
	}

	// Errored renders never reach the panel.
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc2","toolName":"show_content","args":{"path":"nope.md","content":"nope"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc2","toolName":"show_content","isError":true}`)
	if engine.state.content.Path == "nope.md" {
		t.Fatal("errored show_content was promoted")
	}
}

// show_content format field: when the agent passes format:'html', the
// content doc carries it through; without it, defaults to "markdown".
func TestShowContentFormat(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	// HTML format: the agent passes format:'html'.
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"h1","toolName":"show_content","args":{"path":"diagram.html","content":"<svg/>","format":"html"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"h1","toolName":"show_content","isError":false}`)

	if engine.state.content == nil {
		t.Fatal("expected content for html format")
	}
	if engine.state.content.Format != "html" {
		t.Fatalf("expected format 'html', got %q", engine.state.content.Format)
	}

	// Verify the event payload carries the format.
	_, payload, ok := collector.find(t, isEvent(protocol.EvContentUpdated))
	if !ok {
		t.Fatal("no content.updated event")
	}
	var doc protocol.ContentDoc
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("unmarshal content.updated payload: %v", err)
	}
	if doc.Format != "html" {
		t.Fatalf("event payload format = %q, want 'html'", doc.Format)
	}

	// Default: no format field → "markdown".
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"m1","toolName":"show_content","args":{"path":"notes.md","content":"# Hi"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"m1","toolName":"show_content","isError":false}`)

	if engine.state.content.Format != "markdown" {
		t.Fatalf("expected default format 'markdown', got %q", engine.state.content.Format)
	}
}

// show_content file mode renders an existing file from disk: the backend
// reads it (contents never touch the model transcript) and promotes it.
func TestShowContentFileMode(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "notes.md"), []byte("# Notes\nhello"), 0o644); err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(workspace, "abs.md")
	if err := os.WriteFile(abs, []byte("absolute"), 0o644); err != nil {
		t.Fatal(err)
	}

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = workspace

	// Relative path resolves against the workspace.
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"f1","toolName":"show_content","args":{"file":"notes.md"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"f1","toolName":"show_content","isError":false}`)
	if engine.state.content == nil || engine.state.content.Content != "# Notes\nhello" {
		t.Fatalf("file content not promoted: %+v", engine.state.content)
	}
	if engine.state.content.Path != "notes.md" {
		t.Fatalf("label should be the model-supplied path, got %q", engine.state.content.Path)
	}

	// Absolute path works too.
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"f2","toolName":"show_content","args":{"file":`+strconv.Quote(abs)+`}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"f2","toolName":"show_content","isError":false}`)
	if engine.state.content.Content != "absolute" {
		t.Fatalf("absolute file not promoted: %+v", engine.state.content)
	}

	// Missing file: no promotion, error notification.
	engine.state.content = nil
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"f3","toolName":"show_content","args":{"file":"ghost.md"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"f3","toolName":"show_content","isError":false}`)
	if engine.state.content != nil {
		t.Fatal("missing file must not promote")
	}
	if _, _, ok := collector.find(t, func(envType, name string, raw json.RawMessage) bool {
		if envType != "event" || name != protocol.EvNotification {
			return false
		}
		var n protocol.NotificationPayload
		_ = json.Unmarshal(raw, &n)
		return n.Level == "error"
	}); !ok {
		t.Fatal("no error notification for missing file")
	}
}

// A tool call that ends with its approval still pending (user aborted the
// run mid-dialog) auto-dismisses the approval — no zombies.
func TestToolEndDismissesPendingApproval(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = t.TempDir()

	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc-9","toolName":"propose_edit","args":{"path":"a.md"}}`)
	feedNorm(engine, "extension_ui_request", `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"coconut://propose_edit","message":"{\"toolCallId\":\"tc-9\",\"path\":\"a.md\",\"what\":\"w\",\"why\":\"y\",\"edits\":[{\"oldText\":\"\",\"newText\":\"x\"}]}"}`)
	if len(engine.state.approvals) != 1 {
		t.Fatalf("approval not registered: %+v", engine.state.approvals)
	}

	// Tool ends (error/abort) without the approval being answered.
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc-9","toolName":"propose_edit","isError":true}`)
	if len(engine.state.approvals) != 0 || len(engine.state.pendingByID) != 0 {
		t.Fatal("zombie approval survived tool_execution_end")
	}
	name, raw, ok := collector.find(t, isEvent(protocol.EvApprovalResolved))
	if !ok {
		t.Fatal("no approval.resolved emitted for zombie")
	}
	var res protocol.ApprovalResolvedPayload
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatal(err)
	}
	if res.Decision != protocol.DecisionDismiss {
		t.Fatalf("zombie resolution = %q, want dismiss", res.Decision)
	}
	_ = name
}

// …and the normal approve-then-finish path must NOT double-resolve.
func TestApprovedToolEndDoesNotDoubleResolve(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = t.TempDir()
	go engine.Run(t.Context())

	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc-1","toolName":"propose_edit","args":{"path":"a.md"}}`)
	feedNorm(engine, "extension_ui_request", `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"coconut://propose_edit","message":"{\"toolCallId\":\"tc-1\",\"path\":\"a.md\",\"what\":\"w\",\"why\":\"y\",\"edits\":[{\"oldText\":\"\",\"newText\":\"x\"}]}"}`)
	apID := engine.state.approvals[0].ID

	// User approves (respond path removes the pending entry)…
	resp := sendCommand(t, engine, protocol.CmdApprovalRespond, map[string]any{"approvalId": apID, "decision": "allow"})
	if !resp.OK {
		t.Fatalf("approval.respond: %s", respBytes(resp))
	}
	// …then the tool finishes. No second approval.resolved.
	before := 0
	for _, _ = range collector.envs {
		_ = before
	} // (count via find below)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc-1","toolName":"propose_edit","isError":false}`)
	collector.mu.Lock()
	count := 0
	for _, rawEnv := range collector.envs {
		var head struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		_ = json.Unmarshal(rawEnv, &head)
		if head.Type == "event" && head.Name == protocol.EvApprovalResolved {
			count++
		}
	}
	collector.mu.Unlock()
	if count != 1 {
		t.Fatalf("approval.resolved emitted %d times, want exactly 1 (from the respond path)", count)
	}
}

// Whitelisted run commands skip the approval bridge entirely (no
// extension_ui_request), but they still pass what/why in their tool args.
// Those must be captured at tool_execution_start so the chat timeline can render
// the human-readable description — not just the truncated command label.
func TestWhitelistedRunCapturesWhatWhy(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	// Simulates an agent calling the `run` tool for a whitelisted command.
	// The what/why are required by the run schema and appear in tool args,
	// even though no approval dialog will follow (the command is whitelisted).
	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc1","toolName":"run","args":{"command":"ls -la","what":"List project files in the current directory","why":"Need to see the directory structure before editing"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc1","toolName":"run","isError":false}`)

	if len(engine.state.toolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(engine.state.toolCalls))
	}
	call := engine.state.toolCalls[0]
	if call.What != "List project files in the current directory" {
		t.Errorf("What = %q, want the action description from tool args", call.What)
	}
	if call.Why != "Need to see the directory structure before editing" {
		t.Errorf("Why = %q, want the rationale from tool args", call.Why)
	}
	if call.Status != protocol.ToolDone {
		t.Errorf("Status = %q, want %s", call.Status, protocol.ToolDone)
	}
	if len(engine.state.approvals) != 0 {
		t.Errorf("whitelisted run should not create an approval, got %d", len(engine.state.approvals))
	}
	if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
		return envType == "event" && name == protocol.EvApprovalRequested
	}); ok {
		t.Fatal("approval.requested emitted for a whitelisted run command")
	}
}

// groupLabel in tool args is captured at tool_execution_start and stored
// on the ToolCall so the frontend grouper can collapse calls into groups.
func TestNormalizeToolCallGroupLabel(t *testing.T) {
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}

	feedNorm(engine, "tool_execution_start", `{"toolCallId":"tc1","toolName":"read","args":{"path":"foo.txt","what":"Read foo.txt","why":"Need to check the content","groupLabel":"investigate"}}`)
	feedNorm(engine, "tool_execution_end", `{"toolCallId":"tc1","toolName":"read","isError":false}`)

	if len(engine.state.toolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(engine.state.toolCalls))
	}
	call := engine.state.toolCalls[0]
	if call.GroupLabel != "investigate" {
		t.Errorf("GroupLabel = %q, want %q", call.GroupLabel, "investigate")
	}
	if call.What != "Read foo.txt" {
		t.Errorf("What = %q, want %q", call.What, "Read foo.txt")
	}
	if call.Why != "Need to check the content" {
		t.Errorf("Why = %q, want %q", call.Why, "Need to check the content")
	}
	if call.Status != protocol.ToolDone {
		t.Errorf("Status = %q, want %s", call.Status, protocol.ToolDone)
	}
}
