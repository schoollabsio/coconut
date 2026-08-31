package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jschool/custard/internal/piadapter"
	"github.com/jschool/custard/internal/protocol"
)

// ---------------------------------------------------------------------------
// Sidecar lifecycle (all actor-only: *Locked methods run on the actor)
// ---------------------------------------------------------------------------

// startSidecarLocked launches the pi sidecar for the current workspace.
// When restore is true and a previous session file is known, the session
// is switched back and messages rebuilt before done is called.
func (e *Engine) startSidecarLocked(restore bool, done func(error)) {
	if e.state.workspacePath == "" {
		if done != nil {
			done(errors.New("no workspace configured"))
		}
		return
	}

	s := e.state.settings
	ws := e.state.app.ws(e.state.workspacePath)
	applyPendingRename(e.state.workspacePath, ws)
	sessionDir, err := ensureSessionDir(e.state.workspacePath, ws.SessionSlug)
	if err != nil {
		if done != nil {
			done(err)
		}
		return
	}
	adoptLegacySessionFile(e.state.workspacePath, ws)
	_ = saveState(e.cfg.ConfigDir, e.state.app)
	spec := buildLaunchSpec(e.cfg, s, ws.SessionName, e.state.workspacePath, sessionDir)
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
		ws := e.state.app.ws(e.state.workspacePath)
		if st.SessionName != "" {
			e.state.sessionName = st.SessionName
			ws.SessionName = st.SessionName
		}

		finish := func() {
			e.rebuildMessagesLocked(func() {
				e.emitEvent(protocol.EvSessionRestored, map[string]any{
					"workspacePath": e.state.workspacePath,
					"sessionName":   e.state.sessionName,
				}, "")
				if done != nil {
					done(nil)
				}
			})
		}

		if st.SessionFile != "" && st.SessionFile != ws.LastSessionFile {
			ws.LastSessionFile = st.SessionFile
			_ = saveState(e.cfg.ConfigDir, e.state.app)
		}

		last := ws.LastSessionFile
		if restore && last != "" && st.SessionFile != last && fileExists(last) {
			e.sendPi("switch_session", map[string]any{"sessionPath": last}, func(resp piadapter.Response, err error) {
				if err != nil || !resp.Success {
					e.notify("warning", "could not restore previous session; starting fresh")
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
	e.startSidecarLocked(true, func(err error) {
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

func buildLaunchSpec(cfg EngineConfig, s Settings, sessionName, workspace, sessionDir string) piadapter.LaunchSpec {
	agentDir := filepath.Join(cfg.ConfigDir, "agent")

	binary := os.Getenv("CUSTARD_PI_BINARY")
	if binary == "" {
		binary = piadapter.ResolveBinary(cfg.SelfPath)
	}

	// fakepi development seam: CUSTARD_PI_BINARY points at a fakepi
	// build; it takes -scenario instead of pi's flags.
	if strings.Contains(filepath.Base(binary), "fakepi") {
		args := []string{}
		if sc := os.Getenv("CUSTARD_PI_SCENARIO"); sc != "" {
			args = append(args, "-scenario", sc)
		}
		return piadapter.LaunchSpec{Binary: binary, Args: args, Dir: workspace}
	}

	return piadapter.BuildLaunchSpec(piadapter.SidecarSettings{
		Provider:      s.Provider,
		Model:         s.Model,
		APIKey:        sidecarAPIKey(s),
		APIKeyEnv:     sidecarKeyEnvVars(s),
		BashWhitelist: s.BashWhitelist,
		SessionName:   sessionName,
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
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("sidecar config: write models.json: %w", err)
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
// joined); toolResult/bashExecution are skipped (the tool log is
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
