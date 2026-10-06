package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jschool/coconut/internal/protocol"
)

// ---------------------------------------------------------------------------
// Per-agent custom system prompts
//
// Each agent may carry a user-authored system-prompt.md in its directory:
//
//	<workspace>/.coconut/agents/<slug>/system-prompt.md
//
// The sidecar launch passes the path to the extension
// (COCONUT_SYSTEM_PROMPT_FILE), which appends the file's contents to the
// system prompt on every before_agent_start hook. That hook fires per user
// prompt and the extension re-reads the file each time, so saving here
// takes effect on the agent's NEXT message — no sidecar restart.
// ---------------------------------------------------------------------------

// maxSystemPromptBytes guards against accidents (a pasted log file), not
// adversaries — the user owns the file.
const maxSystemPromptBytes = 32 * 1024

func systemPromptPath(workspace, slug string) string {
	return filepath.Join(agentDirFor(workspace, slug), "system-prompt.md")
}

// validAgentSlug rejects path escapes: every coconut-created slug satisfies
// Slugify(slug) == slug, and Slugify never emits separators or "..".
func validAgentSlug(slug string) bool {
	return slug != "" && slug == Slugify(slug)
}

// readSystemPrompt returns the agent's prompt, "" when none exists.
func readSystemPrompt(workspace, slug string) (string, error) {
	data, err := os.ReadFile(systemPromptPath(workspace, slug))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// writeSystemPrompt persists prompt atomically (multiple windows share the
// file); an empty prompt removes the file.
func writeSystemPrompt(workspace, slug, prompt string) error {
	path := systemPromptPath(workspace, slug)
	if prompt == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("system prompt: remove: %w", err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("system prompt: mkdir: %w", err)
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, []byte(prompt), 0o600); err != nil {
		return fmt.Errorf("system prompt: write: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("system prompt: rename: %w", err)
	}
	return nil
}

func (e *Engine) cmdAgentPromptGet(cmd protocol.Command, respond chan []byte) {
	var p protocol.AgentPromptGetPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !validAgentSlug(p.Slug) {
		respond <- respondErr(cmd, "bad_payload", "agent.prompt.get needs a valid {slug}")
		return
	}
	if e.state.workspacePath == "" {
		respond <- respondErr(cmd, "no_workspace", "pick a workspace first")
		return
	}
	prompt, err := readSystemPrompt(e.state.workspacePath, p.Slug)
	if err != nil {
		respond <- respondErr(cmd, "read_failed", err.Error())
		return
	}
	respond <- respondOK(cmd, protocol.AgentPromptResult{Slug: p.Slug, Prompt: prompt})
}

func (e *Engine) cmdAgentPromptSet(cmd protocol.Command, respond chan []byte) {
	var p protocol.AgentPromptSetPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || !validAgentSlug(p.Slug) {
		respond <- respondErr(cmd, "bad_payload", "agent.prompt.set needs a valid {slug, prompt}")
		return
	}
	if e.state.workspacePath == "" {
		respond <- respondErr(cmd, "no_workspace", "pick a workspace first")
		return
	}
	prompt := strings.TrimSpace(p.Prompt)
	if strings.ContainsRune(prompt, 0) {
		respond <- respondErr(cmd, "bad_payload", "prompt contains NUL bytes")
		return
	}
	if len(prompt) > maxSystemPromptBytes {
		respond <- respondErr(cmd, "too_large", fmt.Sprintf("prompt exceeds %d bytes (got %d)", maxSystemPromptBytes, len(prompt)))
		return
	}
	if err := writeSystemPrompt(e.state.workspacePath, p.Slug, prompt); err != nil {
		respond <- respondErr(cmd, "write_failed", err.Error())
		return
	}
	// Sibling windows refresh their picker badge; the running sidecar needs
	// no restart — the extension re-reads the file on the next prompt.
	e.emitEvent(protocol.EvAgentPromptChanged, map[string]string{"slug": p.Slug}, cmd.ID)
	respond <- respondOK(cmd, protocol.AgentPromptResult{Slug: p.Slug, Prompt: prompt})
}
