package core

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jschool/coconut/internal/piadapter"
	"github.com/jschool/coconut/internal/protocol"
)

// ---------------------------------------------------------------------------
// Sidecar lifecycle (all actor-only: *Locked methods run on the actor)
// ---------------------------------------------------------------------------

// startSidecarLocked launches the pi sidecar for an agent in the current
// workspace. switchTo (a transcript path) forces a session switch;
// otherwise the agent's recorded last session is restored unless fresh is
// true. Messages are rebuilt before done is called.
func (e *Engine) startSidecarLocked(agentSlug, switchTo string, fresh bool, done func(error)) {
	if e.state.workspacePath == "" {
		if done != nil {
			done(errors.New("no workspace configured"))
		}
		return
	}

	s := e.state.settings
	ws := e.state.app.ws(e.state.workspacePath)
	agent := ws.agent(agentSlug)
	if effective := applyPendingRename(e.state.workspacePath, agentSlug, agent); effective != agentSlug {
		// Deferred rename landed: re-key the agent under its new slug.
		delete(ws.Agents, agentSlug)
		ws.Agents[effective] = agent
		if ws.LastAgent == agentSlug {
			ws.LastAgent = effective
		}
		agentSlug = effective
	}
	sessionDir, err := ensureAgentDir(e.state.workspacePath, agentSlug)
	if err != nil {
		if done != nil {
			done(err)
		}
		return
	}
	adoptLegacySessionFile(e.state.workspacePath, agentSlug, agent)
	ws.LastAgent = agentSlug
	e.state.agentSlug = agentSlug
	e.state.agentName = agent.Name
	_ = saveState(e.cfg.ConfigDir, e.state.app)
	spec := buildLaunchSpec(e.cfg, s, agent.Name, e.state.workspacePath, sessionDir)
	if err := prepareSidecarConfig(e.cfg.ConfigDir, s); err != nil {
		if done != nil {
			done(err)
		}
		return
	}

	env := piadapter.MergedEnv(spec.Env)
	client, cmd, err := piadapter.StartProcess(piadapter.ProcessConfig{
		Binary: spec.Binary,
		Args:   spec.Args,
		Dir:    spec.Dir,
	}, env)
	if err != nil {
		if done != nil {
			done(err)
		}
		return
	}

	e.pi = client
	e.piProc = cmd.Process
	e.piUp = true

	// Pump pi events into the actor.
	go func() {
		for ev := range client.Events() {
			select {
			case e.inbox <- piEventInput{ev: ev}:
			case <-e.done:
				return
			}
		}
	}()
	go func() {
		<-client.Exited()
		select {
		case e.inbox <- piGoneInput{err: client.ExitErr()}:
		case <-e.done:
		}
	}()

	// Post-start: identify session, optionally restore, rebuild history.
	e.sendPi("get_state", nil, func(resp piadapter.Response, err error) {
		if err != nil || !resp.Success {
			if done != nil {
				done(fmt.Errorf("sidecar get_state: %v %s", err, resp.Err))
			}
			return
		}
		var st struct {
			SessionFile string `json:"sessionFile"`
			SessionName string `json:"sessionName"`
		}
		_ = json.Unmarshal(resp.Data, &st)
		agent := e.state.app.ws(e.state.workspacePath).agent(e.state.agentSlug)
		if st.SessionName != "" && st.SessionName != agent.Name {
			// pi is display-name authoritative after a restore.
			e.state.agentName = st.SessionName
			agent.Name = st.SessionName
		}

		sessionFile := st.SessionFile

		finish := func() {
			// Tool call reconstruction (synchronous file read) and
			// message reconstruction (async pi RPC) are independent
			// siblings — no semantic ordering. Run the sync ones
			// first, then kick off the async message fetch.
			e.rebuildToolCallsLocked(sessionFile)
			// The content library is per-agent: rescan from disk, then pick
			// the panel content (the session's last shown doc, restored
			// from args above, wins; otherwise the library's newest entry).
			e.rescanContentLibraryLocked()
			e.reconcileContentSelectionLocked()
			e.rebuildMessagesLocked(func() {
				e.state.resequenceRestoredTimeline()
				e.emitEvent(protocol.EvSessionRestored, map[string]any{
					"workspacePath": e.state.workspacePath,
					"agentName":     e.state.agentName,
					"agentSlug":     e.state.agentSlug,
				}, "")
				if done != nil {
					done(nil)
				}
			})
		}

		if st.SessionFile != "" && st.SessionFile != agent.LastSessionFile {
			agent.LastSessionFile = st.SessionFile
			_ = saveState(e.cfg.ConfigDir, e.state.app)
		}

		target := switchTo
		if target == "" && !fresh {
			target = agent.LastSessionFile
		}
		if target != "" && st.SessionFile != target && fileExists(target) {
			e.sendPi("switch_session", map[string]any{"sessionPath": target}, func(resp piadapter.Response, err error) {
				if err != nil || !resp.Success {
					e.notify("warning", "could not restore previous session; starting fresh")
				} else {
					agent.LastSessionFile = target
					sessionFile = target
					_ = saveState(e.cfg.ConfigDir, e.state.app)
				}
				finish()
			})
			return
		}
		finish()
	})
}

// rebuildMessagesLocked fetches pi's message history into domain state.
func (e *Engine) rebuildMessagesLocked(done func()) {
	e.sendPi("get_messages", nil, func(resp piadapter.Response, err error) {
		if err == nil && resp.Success {
			e.state.messages = parsePiMessages(resp.Data)
		}
		done()
	})
}

// rebuildToolCallsLocked reads the pi session transcript file and
// reconstructs tool call history (and the most recent show_content
// content doc) into domain state. Synchronous — it's a file read, not a
// pi RPC, so no callback is needed (unlike rebuildMessagesLocked).
// Actor-only.
func (e *Engine) rebuildToolCallsLocked(sessionFile string) {
	if sessionFile == "" {
		return
	}

	f, err := os.Open(sessionFile)
	if err != nil {
		// File doesn't exist (e.g. very first run) — nothing to restore.
		return
	}
	defer f.Close()

	type tcEntry struct {
		id             string
		tool           string
		label          string
		path           string
		what           string
		why            string
		groupLabel     string
		status         string
		messageOrdinal int
	}

	calls := map[string]*tcEntry{}
	var order []string
	var lastShowContentArgs map[string]any

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	assistantOrdinal := 0
	currentOrdinal := 0
	toolCallCounter := 0
	for scanner.Scan() {
		var line struct {
			Type       string          `json:"type"`
			ToolCallID string          `json:"toolCallId"`
			ToolName   string          `json:"toolName"`
			Args       map[string]any  `json:"args"`
			IsError    bool            `json:"isError"`
			Title      string          `json:"title"`
			MessageRaw json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}

		switch line.Type {
		case "tool_execution_start":
			info := extractToolArgs(line.ToolName, line.Args)
			entry, exists := calls[line.ToolCallID]
			if !exists {
				entry = &tcEntry{id: line.ToolCallID, status: protocol.ToolDone}
				calls[line.ToolCallID] = entry
				order = append(order, line.ToolCallID)
			}
			entry.tool = line.ToolName
			entry.label = toolLabel(line.ToolName, info)
			entry.path = info.Path
			entry.what = info.What
			entry.why = info.Why
			entry.groupLabel = info.GroupLabel
			if currentOrdinal > 0 {
				entry.messageOrdinal = currentOrdinal
			}

			// Track the most recent show_content args for content restoration.
			if line.ToolName == "show_content" && line.Args != nil {
				lastShowContentArgs = line.Args
			}

		case "tool_execution_end":
			entry, ok := calls[line.ToolCallID]
			if !ok {
				continue
			}
			if line.IsError {
				entry.status = protocol.ToolError
			} else {
				entry.status = protocol.ToolDone
				// Restore content for the last successful show_content call.
				if entry.tool == "show_content" && lastShowContentArgs != nil {
					e.restoreContentFromArgs(lastShowContentArgs)
				}
			}

		case "extension_ui_request":
			// Approval requests carry the final what/why for the tool call.
			// Update the matching entry to match live behavior (where
			// registerApprovalLocked overwrites call.What with approval.What).
			if !strings.HasPrefix(line.Title, "coconut://") {
				continue
			}
			var msgData struct {
				ToolCallID string `json:"toolCallId"`
				What       string `json:"what"`
				Why        string `json:"why"`
			}
			if err := json.Unmarshal(line.MessageRaw, &msgData); err != nil {
				continue
			}
			if entry, ok := calls[msgData.ToolCallID]; ok {
				entry.what = msgData.What
				entry.why = msgData.Why
			}

		case "message":
			// v3 transcript format — used by the real pi on disk. Tool
			// calls are embedded as toolCall content blocks within
			// assistant messages (not separate RPC events).
			var msg struct {
				Role    string `json:"role"`
				Content []struct {
					Type      string         `json:"type"`
					Name      string         `json:"name"`
					ID        string         `json:"id"`
					Arguments map[string]any `json:"arguments"`
					Text      string         `json:"text"`
				} `json:"content"`
			}
			if err := json.Unmarshal(line.MessageRaw, &msg); err != nil {
				continue
			}
			if msg.Role != "assistant" {
				continue
			}
			hasText := false
			for _, block := range msg.Content {
				if block.Type == "text" && block.Text != "" {
					hasText = true
					break
				}
			}
			if hasText {
				assistantOrdinal++
				currentOrdinal = assistantOrdinal
			} else {
				currentOrdinal = 0
			}
			for _, block := range msg.Content {
				if block.Type != "toolCall" || block.Name == "" {
					continue
				}
				info := extractToolArgs(block.Name, block.Arguments)
				id := block.ID
				if id == "" {
					// v3 messages may omit the toolCallId; synthesize one.
					toolCallCounter++
					id = fmt.Sprintf("transcript-%d", toolCallCounter)
				}
				entry, exists := calls[id]
				if !exists {
					entry = &tcEntry{id: id, status: protocol.ToolDone}
					calls[id] = entry
					order = append(order, id)
				}
				entry.tool = block.Name
				entry.label = toolLabel(block.Name, info)
				entry.path = info.Path
				entry.what = info.What
				entry.why = info.Why
				entry.groupLabel = info.GroupLabel
				entry.messageOrdinal = currentOrdinal
				if block.Name == "show_content" && block.Arguments != nil {
					e.restoreContentFromArgs(block.Arguments)
					lastShowContentArgs = block.Arguments
				}
			}
		}
	}

	restored := make([]restoredToolCall, 0, len(order))
	for _, id := range order {
		entry := calls[id]
		restored = append(restored, restoredToolCall{
			call: protocol.ToolCall{
				ID:         entry.id,
				Tool:       entry.tool,
				Label:      entry.label,
				Path:       entry.path,
				What:       entry.what,
				Why:        entry.why,
				Status:     entry.status,
				GroupLabel: entry.groupLabel,
			},
			messageOrdinal: entry.messageOrdinal,
		})
	}
	e.state.restoredToolCalls = restored
}

// extractToolArgs builds a toolStartInfo from a tool execution's args
// map, mirroring the inline extraction in normalize.go.
func extractToolArgs(toolName string, args map[string]any) toolStartInfo {
	info := toolStartInfo{ToolName: toolName, Args: args}
	if v, ok := args["path"].(string); ok {
		info.Path = v
	}
	if v, ok := args["command"].(string); ok {
		info.Command = v
	}
	if v, ok := args["content"].(string); ok {
		info.Content = v
	}
	if v, ok := args["file"].(string); ok {
		info.File = v
	}
	if v, ok := args["format"].(string); ok {
		info.Format = v
	}
	if v, ok := args["what"].(string); ok {
		info.What = v
	}
	if v, ok := args["why"].(string); ok {
		info.Why = v
	}
	if v, ok := args["groupLabel"].(string); ok {
		info.GroupLabel = v
	}
	return info
}

// restoreContentFromArgs restores the content panel from a show_content
// tool call's args. Mode A (path+content): uses the provided content.
// Mode B (file): re-reads the file from disk. Actor-only.
func (e *Engine) restoreContentFromArgs(args map[string]any) {
	if args == nil {
		return
	}
	format := "markdown"
	if f, ok := args["format"].(string); ok {
		format = contentFormat(f)
	}
	if file, ok := args["file"].(string); ok && file != "" {
		path := file
		if !filepath.IsAbs(path) {
			path = filepath.Join(e.state.workspacePath, file)
		}
		if data, err := os.ReadFile(path); err == nil {
			e.state.content = &protocol.ContentDoc{
				Path:      file,
				Content:   string(data),
				Format:    format,
				UpdatedAt: nowMs(),
			}
		}
		return
	}
	if path, ok := args["path"].(string); ok && path != "" {
		content, _ := args["content"].(string)
		e.state.content = &protocol.ContentDoc{
			Path:      path,
			Content:   content,
			Format:    format,
			UpdatedAt: nowMs(),
		}
	}
}

func (e *Engine) stopSidecarLocked() {
	if e.pi != nil {
		_ = e.pi.Close()
	}
	if e.piProc != nil {
		_ = e.piProc.Kill()
	}
	e.pi = nil
	e.piProc = nil
	e.piUp = false
}

// onSidecarGone handles unexpected sidecar exit (PLAN.md §11.3).
func (e *Engine) onSidecarGone(err error) {
	wasUp := e.piUp
	e.pi = nil
	e.piProc = nil
	e.piUp = false
	if !wasUp {
		return
	}

	e.emitEvent(protocol.EvSidecarLost, protocol.AgentFailedPayload{
		Error:   "pi_sidecar_exited",
		Message: errString(err, "sidecar exited"),
	}, "")

	if e.state.agentStatus != protocol.StatusIdle {
		e.state.agentStatus = protocol.StatusError
		e.emitEvent(protocol.EvAgentFailed, protocol.AgentFailedPayload{
			Error:   "pi_sidecar_exited",
			Message: "The agent process exited unexpectedly.",
		}, "")
		e.emitEvent(protocol.EvAgentStatusChanged, map[string]string{"status": e.state.agentStatus}, "")
	}

	// Single automatic restart attempt with session restore.
	e.state.resetAgent()
	e.startSidecarLocked(e.state.agentSlug, "", false, func(err error) {
		if err != nil {
			e.notify("error", "sidecar restart failed: "+err.Error())
			return
		}
		e.notify("info", "agent restarted; previous session restored where possible")
	})
}

// ---------------------------------------------------------------------------
// launch spec assembly (incl. the fakepi dev seam)
// ---------------------------------------------------------------------------

func buildLaunchSpec(cfg EngineConfig, s Settings, agentName, workspace, sessionDir string) piadapter.LaunchSpec {
	agentDir := filepath.Join(cfg.ConfigDir, "agent")

	binary := os.Getenv("COCONUT_PI_BINARY")
	if binary == "" {
		binary = piadapter.ResolveBinary(cfg.SelfPath)
	}

	// fakepi development seam: COCONUT_PI_BINARY points at a fakepi
	// build; it takes -scenario instead of pi's flags.
	if strings.Contains(filepath.Base(binary), "fakepi") {
		args := []string{}
		if sc := os.Getenv("COCONUT_PI_SCENARIO"); sc != "" {
			args = append(args, "-scenario", sc)
		}
		return piadapter.LaunchSpec{
			Binary: binary,
			Args:   args,
			Dir:    workspace,
			Env: []string{
				"COCONUT_AGENT_ENV=" + filepath.Join(filepath.Dir(sessionDir), "env"),
				"COCONUT_SYSTEM_PROMPT_FILE=" + filepath.Join(filepath.Dir(sessionDir), "system-prompt.md"),
				"COCONUT_FAKEPI_TRANSCRIPT_DIR=" + sessionDir,
			},
		}
	}

	return piadapter.BuildLaunchSpec(piadapter.SidecarSettings{
		Provider:         s.Provider,
		Model:            s.Model,
		APIKey:           sidecarAPIKey(s),
		APIKeyEnv:        sidecarKeyEnvVars(s),
		BashWhitelist:    s.BashWhitelist,
		AgentEnvFile:     filepath.Join(filepath.Dir(sessionDir), "env"),
		SystemPromptFile: filepath.Join(filepath.Dir(sessionDir), "system-prompt.md"),
		SessionName:      agentName,
	}, workspace, agentDir, sessionDir, cfg.ExtensionPath, binary)
}

// sidecarAPIKey is the key injected via env: only for a built-in provider
// without a providers: entry (an overridden provider's key lives in
// models.json instead).
func sidecarAPIKey(s Settings) string {
	if _, overridden := s.Providers[s.Provider]; overridden {
		return ""
	}
	return s.APIKey
}

// sidecarKeyEnvVars resolves the env var names pi reads the key from.
func sidecarKeyEnvVars(s Settings) []string {
	if names, known := knownProviderEnv[s.Provider]; known && len(names) > 0 {
		return names
	}
	return nil // piadapter falls back to its convention
}

// prepareSidecarConfig materializes the sidecar's isolated config dir from
// settings.yaml: provider endpoint definitions go to models.json.
// (The API key for built-in providers travels via env, not a file.)
func prepareSidecarConfig(configDir string, cfg Settings) error {
	dir := filepath.Join(configDir, "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("sidecar config: mkdir: %w", err)
	}
	return writeModelsJSON(dir, cfg)
}

// writeModelsJSON translates Settings.Providers into pi's models.json.
// The top-level apiKey feeds the selected provider's entry when that entry
// has no key of its own. Unknown YAML keys (ProviderSettings.Extra) pass
// through untouched. Stale files from a previous configuration are removed.
func writeModelsJSON(dir string, cfg Settings) error {
	path := filepath.Join(dir, "models.json")
	if len(cfg.Providers) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("sidecar config: remove stale models.json: %w", err)
		}
		return nil
	}

	providers := make(map[string]map[string]any, len(cfg.Providers))
	for id, p := range cfg.Providers {
		m := make(map[string]any, len(p.Extra)+6)
		for k, v := range p.Extra {
			m[k] = v
		}
		if p.Name != "" {
			m["name"] = p.Name
		}
		if p.BaseURL != "" {
			m["baseUrl"] = p.BaseURL
		}
		if p.API != "" {
			m["api"] = p.API
		}
		key := p.APIKey
		if key == "" && id == cfg.Provider {
			key = cfg.APIKey
		}
		if key != "" {
			m["apiKey"] = key
		}
		if p.AuthHeader != nil {
			m["authHeader"] = *p.AuthHeader
		}
		if len(p.Headers) > 0 {
			m["headers"] = p.Headers
		}
		if len(p.Models) > 0 {
			m["models"] = p.Models
		}
		providers[id] = m
	}

	data, err := json.MarshalIndent(map[string]any{"providers": providers}, "", "  ")
	if err != nil {
		return fmt.Errorf("sidecar config: marshal models.json: %w", err)
	}
	// Skip if identical: multiple engines (windows) share this file and
	// each sidecar boot materializes it — rewriting identical bytes is
	// churn, and a concurrent reader could otherwise catch a torn write.
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		return nil
	}
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("sidecar config: write models.json: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("sidecar config: rename models.json: %w", err)
	}
	return nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func errString(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// pi message history → domain messages
// ---------------------------------------------------------------------------

// parsePiMessages converts pi's AgentMessage list to chat messages.
// Roles: user (string or block content) and assistant (text blocks
// joined); toolResult/bashExecution are skipped (the chat timeline is
// event-derived, not history-derived).
func parsePiMessages(data json.RawMessage) []protocol.ChatMessage {
	var wrapper struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil
	}
	var out []protocol.ChatMessage
	n := 0
	for _, raw := range wrapper.Messages {
		var head struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			continue
		}
		switch head.Role {
		case "user":
			var msg struct {
				Content json.RawMessage `json:"content"`
			}
			_ = json.Unmarshal(raw, &msg)
			text := userText(msg.Content)
			if text == "" {
				continue
			}
			n++
			out = append(out, protocol.ChatMessage{ID: "h" + itoa(n), Role: "user", Text: text})
		case "assistant":
			var msg struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			_ = json.Unmarshal(raw, &msg)
			var parts []string
			for _, c := range msg.Content {
				if c.Type == "text" && c.Text != "" {
					parts = append(parts, c.Text)
				}
			}
			if len(parts) == 0 {
				continue
			}
			n++
			out = append(out, protocol.ChatMessage{ID: "h" + itoa(n), Role: "assistant", Text: strings.Join(parts, "\n\n")})
		}
	}
	return out
}

func userText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}
