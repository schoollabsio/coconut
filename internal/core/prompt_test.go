package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jschool/coconut/internal/protocol"
)

// newBareEngine boots an engine with a workspace (and optional agent slug)
// but no sidecar — for command handlers that only touch workspace files.
func newBareEngine(t *testing.T, workspace, slug string) (*Engine, *envelopeCollector) {
	t.Helper()
	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	if workspace != "" {
		engine.state.workspacePath = workspace
		engine.state.app.WorkspacePath = workspace
	}
	engine.state.agentSlug = slug
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go engine.Run(ctx)
	t.Cleanup(engine.Shutdown)
	return engine, collector
}

// agent.prompt.set → file on disk → agent.prompt.get roundtrip; an empty
// prompt clears the file.
func TestAgentPromptRoundTrip(t *testing.T) {
	workspace := t.TempDir()
	engine, collector := newBareEngine(t, workspace, "")

	// Nothing set: get returns empty.
	resp := sendCommand(t, engine, protocol.CmdAgentPromptGet, map[string]any{"slug": "bot"})
	if !resp.OK {
		t.Fatalf("get failed: %+v", resp.Error)
	}
	var got protocol.AgentPromptResult
	unmarshalPayload(t, resp, &got)
	if got.Prompt != "" {
		t.Fatalf("expected empty prompt, got %q", got.Prompt)
	}

	// Set persists the trimmed text and emits agent.prompt.changed.
	resp = sendCommand(t, engine, protocol.CmdAgentPromptSet, map[string]any{
		"slug":   "bot",
		"prompt": "  You are a terse reviewer.\n\nAlways run tests first.  ",
	})
	if !resp.OK {
		t.Fatalf("set failed: %+v", resp.Error)
	}
	unmarshalPayload(t, resp, &got)
	want := "You are a terse reviewer.\n\nAlways run tests first."
	if got.Prompt != want {
		t.Fatalf("prompt = %q, want %q", got.Prompt, want)
	}
	data, err := os.ReadFile(systemPromptPath(workspace, "bot"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Fatalf("file = %q, want %q", data, want)
	}
	if _, ok := collector.waitFor(t, 2*time.Second, "agent.prompt.changed", isEvent(protocol.EvAgentPromptChanged)); !ok {
		t.Fatal("agent.prompt.changed never emitted")
	}

	// Roundtrips through get.
	resp = sendCommand(t, engine, protocol.CmdAgentPromptGet, map[string]any{"slug": "bot"})
	if !resp.OK {
		t.Fatalf("get after set failed: %+v", resp.Error)
	}
	unmarshalPayload(t, resp, &got)
	if got.Prompt != want {
		t.Fatalf("roundtrip = %q, want %q", got.Prompt, want)
	}

	// Clearing (whitespace-only trims to empty) removes the file.
	resp = sendCommand(t, engine, protocol.CmdAgentPromptSet, map[string]any{"slug": "bot", "prompt": "   "})
	if !resp.OK {
		t.Fatalf("clear failed: %+v", resp.Error)
	}
	if _, err := os.Stat(systemPromptPath(workspace, "bot")); !os.IsNotExist(err) {
		t.Fatal("prompt file should be removed after clear")
	}
}

// Bad slugs, oversize prompts, NUL bytes, and a missing workspace are
// rejected with the right error codes.
func TestAgentPromptValidation(t *testing.T) {
	workspace := t.TempDir()
	engine, _ := newBareEngine(t, workspace, "")

	// Path escapes / non-slug names are refused (directory traversal guard).
	for _, slug := range []string{"", "..", "../..", "a/b", "MixedCase"} {
		resp := sendCommand(t, engine, protocol.CmdAgentPromptSet, map[string]any{"slug": slug, "prompt": "x"})
		if resp.OK {
			t.Fatalf("slug %q should be rejected", slug)
		}
	}

	resp := sendCommand(t, engine, protocol.CmdAgentPromptSet, map[string]any{
		"slug":   "bot",
		"prompt": strings.Repeat("x", maxSystemPromptBytes+1),
	})
	if resp.OK || resp.Error == nil || resp.Error.Code != "too_large" {
		t.Fatalf("expected too_large, got ok=%v err=%+v", resp.OK, resp.Error)
	}

	resp = sendCommand(t, engine, protocol.CmdAgentPromptSet, map[string]any{
		"slug":   "bot",
		"prompt": "a\x00b",
	})
	if resp.OK || resp.Error == nil || resp.Error.Code != "bad_payload" {
		t.Fatalf("expected bad_payload for NUL, got ok=%v err=%+v", resp.OK, resp.Error)
	}

	bare, _ := newBareEngine(t, "", "")
	resp = sendCommand(t, bare, protocol.CmdAgentPromptGet, map[string]any{"slug": "bot"})
	if resp.OK || resp.Error == nil || resp.Error.Code != "no_workspace" {
		t.Fatalf("expected no_workspace, got ok=%v err=%+v", resp.OK, resp.Error)
	}
}

// scanAgentsLocked badges agents that have a system-prompt.md on disk.
func TestScanAgentsHasSystemPrompt(t *testing.T) {
	workspace := t.TempDir()
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "bot"), "a.jsonl"), "Bot", "hi", true)
	writeFakeSession(t, filepath.Join(sessionsDirFor(workspace, "plain"), "a.jsonl"), "Plain", "hi", true)
	if err := writeSystemPrompt(workspace, "bot", "Be terse."); err != nil {
		t.Fatal(err)
	}

	collector := &envelopeCollector{}
	engine, err := NewEngine(EngineConfig{ConfigDir: t.TempDir(), Emit: collector.emit})
	if err != nil {
		t.Fatal(err)
	}
	engine.state.workspacePath = workspace
	engine.state.app.WorkspacePath = workspace

	agents := engine.scanAgentsLocked()
	bySlug := map[string]protocol.AgentSummary{}
	for _, a := range agents {
		bySlug[a.Slug] = a
	}
	bot, ok := bySlug["bot"]
	if !ok || !bot.HasSystemPrompt {
		t.Fatalf("bot should be badged with hasSystemPrompt: %+v", bySlug)
	}
	if plain, ok := bySlug["plain"]; !ok || plain.HasSystemPrompt {
		t.Fatalf("plain should not be badged: %+v", bySlug)
	}
}
