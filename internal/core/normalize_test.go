package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/jschool/custard/internal/piadapter"
	"github.com/jschool/custard/internal/protocol"
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
	feedNorm(engine, "extension_ui_request", `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"custard://propose_edit","message":"{\"toolCallId\":\"tc-9\",\"path\":\"a.md\",\"what\":\"w\",\"why\":\"y\",\"edits\":[{\"oldText\":\"\",\"newText\":\"x\"}]}"}`)
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
	feedNorm(engine, "extension_ui_request", `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"custard://propose_edit","message":"{\"toolCallId\":\"tc-1\",\"path\":\"a.md\",\"what\":\"w\",\"why\":\"y\",\"edits\":[{\"oldText\":\"\",\"newText\":\"x\"}]}"}`)
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
