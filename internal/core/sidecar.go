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
	spec := buildLaunchSpec(e.cfg, s, e.state.workspacePath)

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
		if st.SessionName != "" {
			e.state.sessionName = st.SessionName
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

		last := s.LastSessionFile
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

func buildLaunchSpec(cfg EngineConfig, s persistedSettings, workspace string) piadapter.LaunchSpec {
	agentDir := filepath.Join(cfg.ConfigDir, "agent")
	sessionDir := filepath.Join(cfg.ConfigDir, "sessions")

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
		APIKey:        s.APIKey,
		BashWhitelist: s.BashWhitelist,
		SessionName:   s.SessionName,
	}, workspace, agentDir, sessionDir, cfg.ExtensionPath, binary)
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
