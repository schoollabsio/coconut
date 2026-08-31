package core

import (
	"encoding/json"
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
