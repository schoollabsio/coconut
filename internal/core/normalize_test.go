package core

import (
	"context"
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

// write_content renders are approval-gated: the document reaches the
// content panel only when the user approves.
func TestWriteContentApprovalGate(t *testing.T) {
	newEngineWithRequest := func(t *testing.T) (*Engine, *envelopeCollector) {
		collector := &envelopeCollector{}
		engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		go engine.Run(ctx)
		feedNorm(engine, "extension_ui_request", `{"type":"extension_ui_request","id":"r1","method":"confirm","title":"custard://write_content","message":"{\"toolCallId\":\"tc1\",\"path\":\"report.md\",\"content\":\"# Hello\\n\\nbody\"}"}`)
		return engine, collector
	}

	t.Run("approve promotes to panel", func(t *testing.T) {
		engine, collector := newEngineWithRequest(t)

		if len(engine.state.approvals) != 1 {
			t.Fatalf("expected 1 pending approval, got %d", len(engine.state.approvals))
		}
		ap := engine.state.approvals[0]
		if ap.Kind != protocol.ApprovalKindWriteContent || ap.Content != "# Hello\n\nbody" {
			t.Fatalf("bad approval: %+v", ap)
		}
		if engine.state.content != nil {
			t.Fatal("content promoted before approval")
		}
		if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
			return envType == "event" && name == protocol.EvApprovalRequested
		}); !ok {
			t.Fatal("no approval.requested event")
		}

		resp := sendCommand(t, engine, protocol.CmdApprovalRespond, map[string]any{"approvalId": ap.ID, "decision": "allow"})
		if !resp.OK {
			t.Fatalf("approval.respond: %+v", resp.Error)
		}
		if engine.state.content == nil || engine.state.content.Content != "# Hello\n\nbody" {
			t.Fatalf("content not promoted on approval: %+v", engine.state.content)
		}
		if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
			return envType == "event" && name == protocol.EvContentUpdated
		}); !ok {
			t.Fatal("no content.updated event after approval")
		}
	})

	t.Run("dismiss never promotes", func(t *testing.T) {
		engine, collector := newEngineWithRequest(t)
		ap := engine.state.approvals[0]

		resp := sendCommand(t, engine, protocol.CmdApprovalRespond, map[string]any{"approvalId": ap.ID, "decision": "dismiss"})
		if !resp.OK {
			t.Fatalf("approval.respond: %+v", resp.Error)
		}
		if engine.state.content != nil {
			t.Fatal("content promoted despite dismissal")
		}
		if _, _, ok := collector.find(t, func(envType, name string, _ json.RawMessage) bool {
			return envType == "event" && name == protocol.EvContentUpdated
		}); ok {
			t.Fatal("content.updated emitted for dismissed render")
		}
	})
}
