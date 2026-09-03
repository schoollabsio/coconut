package core

import (
	"encoding/json"
	"os"

	"github.com/jschool/coconut/internal/piadapter"
	"github.com/jschool/coconut/internal/protocol"
)

// routeCommand dispatches one frontend command on the actor goroutine.
// The response is delivered on the buffered respond channel — either
// synchronously by the handler, or later by a pi continuation. Handlers
// must NEVER block the actor waiting for a continuation (that deadlocks
// the single-writer loop).
func (e *Engine) routeCommand(cmd protocol.Command, respond chan []byte) {
	switch cmd.Name {
	case protocol.CmdSessionRestore:
		e.cmdSessionRestore(cmd, respond)
	case protocol.CmdAgentOpen:
		e.cmdAgentOpen(cmd, respond)
	case protocol.CmdAgentRename:
		e.cmdAgentRename(cmd, respond)
	case protocol.CmdAgentReset:
		e.cmdAgentReset(cmd, respond)
	case protocol.CmdAgentList:
		respond <- respondOK(cmd, map[string]any{"agents": e.scanAgentsLocked()})
	case protocol.CmdWorkspaceSet:
		e.cmdWorkspaceSet(cmd, respond)
	case protocol.CmdAgentStart:
		e.cmdAgentStart(cmd, respond)
	case protocol.CmdAgentCancel:
		e.cmdAgentCancel(cmd, respond)
	case protocol.CmdApprovalRespond:
		e.cmdApprovalRespond(cmd, respond)
	case protocol.CmdSettingsGet:
		respond <- respondOK(cmd, protocol.SettingsYAMLPayload{YAML: e.state.settingsRaw})
	case protocol.CmdSettingsValidate:
		e.cmdSettingsValidate(cmd, respond)
	case protocol.CmdSettingsSave:
		e.cmdSettingsSave(cmd, respond)
	default:
		respond <- respondErr(cmd, "unknown_command", "unknown command: "+cmd.Name)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func respondOK(cmd protocol.Command, payload any) []byte {
	b, _ := json.Marshal(protocol.OKResponse(cmd.ID, payload))
	return b
}

func respondErr(cmd protocol.Command, code, message string) []byte {
	b, _ := json.Marshal(protocol.ErrResponse(cmd.ID, code, message))
	return b
}

// viaPi sends a pi command whose continuation computes the response.
func (e *Engine) viaPi(cmd protocol.Command, respond chan []byte, name string, fields map[string]any, cont func(resp piadapter.Response, err error) []byte) {
	e.sendPi(name, fields, func(resp piadapter.Response, err error) {
		respond <- cont(resp, err)
	})
}

// ---------------------------------------------------------------------------
// session / workspace
// ---------------------------------------------------------------------------

// cmdSessionRestore is the startup bootstrap: reopen the last workspace's
// last agent (fast path — no picker at launch).
func (e *Engine) cmdSessionRestore(cmd protocol.Command, respond chan []byte) {
	if e.state.workspacePath == "" {
		respond <- respondOK(cmd, map[string]any{"needsWorkspace": true})
		return
	}
	if e.piUp {
		respond <- respondOK(cmd, map[string]any{
			"needsWorkspace": false,
			"agentName":      e.state.agentName,
			"agentSlug":      e.state.agentSlug,
		})
		return
	}
	slug := e.state.app.ws(e.state.workspacePath).LastAgent
	if slug == "" {
		slug = "primary"
	}
	e.startSidecarLocked(slug, "", false, func(err error) {
		if err != nil {
			respond <- respondErr(cmd, "pi_start_failed", err.Error())
			return
		}
		respond <- respondOK(cmd, map[string]any{
			"needsWorkspace": false,
			"agentName":      e.state.agentName,
			"agentSlug":      e.state.agentSlug,
		})
	})
}

// cmdAgentOpen opens (or creates) an agent, optionally at a specific
// session or forcing a fresh one. Restarts the world, like workspace.set.
func (e *Engine) cmdAgentOpen(cmd protocol.Command, respond chan []byte) {
	var p protocol.AgentOpenPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || (p.Slug == "" && p.Name == "") {
		respond <- respondErr(cmd, "bad_payload", "agent.open needs {slug} or {name}")
		return
	}
	if e.state.workspacePath == "" {
		respond <- respondErr(cmd, "no_workspace", "pick a workspace first")
		return
	}
	slug := p.Slug
	if slug == "" {
		slug = Slugify(p.Name)
	}
	if p.Name != "" {
		e.state.app.ws(e.state.workspacePath).agent(slug).Name = p.Name
	}

	e.stopSidecarLocked()
	e.state.resetAgent()
	e.state.content = nil
	e.startSidecarLocked(slug, p.SessionFile, p.New, func(err error) {
		if err != nil {
			respond <- respondErr(cmd, "pi_start_failed", err.Error())
			return
		}
		respond <- respondOK(cmd, map[string]any{
			"agentName": e.state.agentName,
			"agentSlug": e.state.agentSlug,
		})
	})
}

// cmdAgentReset starts a new underlying pi session for the current agent;
// the old transcript stays on disk.
func (e *Engine) cmdAgentReset(cmd protocol.Command, respond chan []byte) {
	if !e.piUp || e.pi == nil {
		respond <- respondErr(cmd, "pi_not_running", "agent sidecar is not running")
		return
	}
	e.viaPi(cmd, respond, "new_session", nil, func(resp piadapter.Response, err error) []byte {
		if err != nil || !resp.Success {
			return respondErr(cmd, "pi_internal_error", errString(err, resp.Err))
		}
		// Track the fresh transcript and clear the conversation view.
		var st struct {
			SessionFile string `json:"sessionFile"`
		}
		// new_session's response has no file; ask get_state.
		e.sendPi("get_state", nil, func(gs piadapter.Response, gerr error) {
			if gerr == nil && gs.Success {
				_ = json.Unmarshal(gs.Data, &st)
				if st.SessionFile != "" {
					agent := e.state.app.ws(e.state.workspacePath).agent(e.state.agentSlug)
					agent.LastSessionFile = st.SessionFile
					_ = saveState(e.cfg.ConfigDir, e.state.app)
				}
			}
			e.state.resetAgent()
			e.state.content = nil
			e.emitEvent(protocol.EvContentUpdated, nil, "")
			e.emitEvent(protocol.EvAgentReset, map[string]any{
				"agentName": e.state.agentName,
				"agentSlug": e.state.agentSlug,
			}, "")
		})
		return respondOK(cmd, map[string]any{
			"agentName": e.state.agentName,
			"agentSlug": e.state.agentSlug,
		})
	})
}

func (e *Engine) cmdAgentRename(cmd protocol.Command, respond chan []byte) {
	var p protocol.AgentRenamePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Name == "" {
		respond <- respondErr(cmd, "bad_payload", "agent.rename needs {name}")
		return
	}
	e.state.agentName = p.Name
	if e.state.workspacePath != "" && e.state.agentSlug != "" {
		agent := e.state.app.ws(e.state.workspacePath).agent(e.state.agentSlug)
		agent.Name = p.Name
		// The physical agent-dir move is deferred to next launch: pi
		// caches the transcript's absolute path and could rewrite the old
		// location mid-session (compaction), splitting the transcript.
		if slug := Slugify(p.Name); slug != e.state.agentSlug {
			agent.PendingSlug = slug
		}
	}
	_ = saveState(e.cfg.ConfigDir, e.state.app)

	if !e.piUp {
		respond <- respondOK(cmd, nil)
		return
	}
	e.viaPi(cmd, respond, "set_session_name", map[string]any{"name": p.Name},
		func(resp piadapter.Response, err error) []byte {
			if err != nil || !resp.Success {
				return respondErr(cmd, "pi_internal_error", errString(err, resp.Err))
			}
			return respondOK(cmd, nil)
		})
}

// handleWorkspacePickOffActor runs the native dialog OFF the actor
// goroutine (it can block for minutes), then forwards as workspace.set.
func (e *Engine) handleWorkspacePickOffActor(cmd protocol.Command) []byte {
	if e.cfg.PickDir == nil {
		return respondErr(cmd, "no_picker", "directory picker unavailable")
	}
	path, err := e.cfg.PickDir()
	if err != nil {
		return respondErr(cmd, "picker_failed", err.Error())
	}
	if path == "" {
		return respondOK(cmd, map[string]any{"cancelled": true})
	}

	payload, _ := json.Marshal(protocol.WorkspaceSetPayload{Path: path})
	setCmd := protocol.Command{Type: "command", ID: cmd.ID, Name: protocol.CmdWorkspaceSet, Payload: payload}
	respond := make(chan []byte, 1)
	e.inbox <- cmdInput{cmd: setCmd, respond: respond}
	return <-respond
}

func (e *Engine) cmdWorkspaceSet(cmd protocol.Command, respond chan []byte) {
	var p protocol.WorkspaceSetPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Path == "" {
		respond <- respondErr(cmd, "bad_payload", "workspace.set needs {path}")
		return
	}
	info, err := os.Stat(p.Path)
	if err != nil || !info.IsDir() {
		respond <- respondErr(cmd, "bad_workspace", "not a directory: "+p.Path)
		return
	}

	// Restart the world on workspace change.
	e.stopSidecarLocked()
	e.state.resetAgent()
	e.state.content = nil
	e.state.workspacePath = p.Path
	e.state.app.WorkspacePath = p.Path
	_ = saveState(e.cfg.ConfigDir, e.state.app)

	// Inventory existing agents: when any exist, the frontend asks the user
	// which agent/session to open (agent.open) instead of auto-starting.
	agents := e.scanAgentsLocked()
	payload := map[string]any{
		"workspace": e.state.workspaceInfo(),
		"agents":    agents,
		"needsPick": len(agents) > 0,
	}
	e.emitEvent(protocol.EvWorkspaceChanged, payload, cmd.ID)

	if len(agents) > 0 {
		respond <- respondOK(cmd, payload)
		return
	}
	// Fresh workspace: start the default agent immediately.
	e.startSidecarLocked("primary", "", false, func(err error) {
		if err != nil {
			respond <- respondErr(cmd, "pi_start_failed", err.Error())
			return
		}
		respond <- respondOK(cmd, payload)
	})
}

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

func (e *Engine) cmdAgentStart(cmd protocol.Command, respond chan []byte) {
	var p protocol.AgentStartPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Prompt == "" {
		respond <- respondErr(cmd, "bad_payload", "agent.start needs {prompt}")
		return
	}
	if !e.piUp || e.pi == nil {
		respond <- respondErr(cmd, "pi_not_running", "agent sidecar is not running (pick a workspace first)")
		return
	}

	// Optimistic user-message echo.
	msg := e.state.appendMessage("user", p.Prompt)
	e.emitEvent(protocol.EvAgentMessage, msg, cmd.ID)
	e.setStatus(protocol.StatusThinking, cmd.ID)

	fields := map[string]any{"message": p.Prompt}
	if e.state.streaming {
		fields["streamingBehavior"] = "followUp"
	}

	e.viaPi(cmd, respond, "prompt", fields, func(resp piadapter.Response, err error) []byte {
		if err != nil {
			return respondErr(cmd, "pi_internal_error", err.Error())
		}
		if !resp.Success {
			e.setStatus(protocol.StatusIdle, cmd.ID)
			return respondErr(cmd, "prompt_rejected", resp.Err)
		}
		return respondOK(cmd, nil)
	})
}

func (e *Engine) cmdAgentCancel(cmd protocol.Command, respond chan []byte) {
	if !e.piUp || e.pi == nil {
		respond <- respondErr(cmd, "pi_not_running", "agent sidecar is not running")
		return
	}
	e.viaPi(cmd, respond, "abort", nil, func(resp piadapter.Response, err error) []byte {
		if err != nil || !resp.Success {
			return respondErr(cmd, "pi_internal_error", errString(err, resp.Err))
		}
		return respondOK(cmd, nil)
	})
}

func (e *Engine) cmdApprovalRespond(cmd protocol.Command, respond chan []byte) {
	var p protocol.ApprovalRespondPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.ApprovalID == "" {
		respond <- respondErr(cmd, "bad_payload", "agent.approval.respond needs {approvalId, decision}")
		return
	}
	pend, ok := e.state.pendingByID[p.ApprovalID]
	if !ok {
		respond <- respondErr(cmd, "approval_not_found", "no pending approval "+p.ApprovalID)
		return
	}

	// Bridge back to the extension's blocked ctx.ui.confirm.
	if p.Decision == protocol.DecisionAllow {
		e.sendPiRaw(map[string]any{"type": "extension_ui_response", "id": pend.piReqID, "confirmed": true})
	} else {
		e.sendPiRaw(map[string]any{"type": "extension_ui_response", "id": pend.piReqID, "cancelled": true})
	}

	delete(e.state.pendingByID, p.ApprovalID)
	for i, a := range e.state.approvals {
		if a.ID == p.ApprovalID {
			e.state.approvals = append(e.state.approvals[:i], e.state.approvals[i+1:]...)
			break
		}
	}
	if pend.toolCall != "" {
		if call := e.state.findToolCall(pend.toolCall); call != nil && call.Status == protocol.ToolPendingApproval {
			call.Status = protocol.ToolRunning
		}
	}
	// The agent is running again (tool now executing / declining).
	e.setStatus(protocol.StatusThinking, cmd.ID)
	e.emitEvent(protocol.EvApprovalResolved, protocol.ApprovalResolvedPayload{
		ApprovalID: p.ApprovalID,
		Decision:   p.Decision,
	}, cmd.ID)
	respond <- respondOK(cmd, nil)
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

// cmdSettingsValidate dry-runs the YAML through parse+validate.
func (e *Engine) cmdSettingsValidate(cmd protocol.Command, respond chan []byte) {
	var p protocol.SettingsValidatePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		respond <- respondErr(cmd, "bad_payload", "settings.validate needs {yaml}")
		return
	}
	_, problems := parseSettingsYAML(p.YAML)
	respond <- respondOK(cmd, protocol.SettingsValidateResult{
		Valid:    !HasErrors(problems),
		Problems: problems,
	})
}

// cmdSettingsSave validates the submitted YAML and refuses to persist when
// it contains errors (the frontend shows the problems and keeps the modal
// open). On success the sidecar restarts so the new config takes effect.
func (e *Engine) cmdSettingsSave(cmd protocol.Command, respond chan []byte) {
	var p protocol.SettingsSavePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		respond <- respondErr(cmd, "bad_payload", "settings.save needs {yaml}")
		return
	}
	cfg, problems, err := saveSettingsYAML(e.cfg.ConfigDir, p.YAML)
	if err != nil {
		respond <- respondErr(cmd, "persist_failed", err.Error())
		return
	}
	if HasErrors(problems) {
		b, _ := json.Marshal(protocol.CommandResponse{
			Type:      "command_response",
			CommandID: cmd.ID,
			OK:        false,
			Payload:   protocol.SettingsValidateResult{Valid: false, Problems: problems},
			Error:     &protocol.ErrorInfo{Code: "validation_failed", Message: "settings validation failed"},
		})
		respond <- b
		return
	}
	e.state.settings = cfg
	e.state.settingsRaw = p.YAML
	e.emitEvent(protocol.EvSettingsChanged, protocol.SettingsYAMLPayload{YAML: p.YAML}, cmd.ID)

	// Launch-relevant settings may have changed; restart the sidecar.
	if e.piUp {
		e.stopSidecarLocked()
		e.state.resetAgent()
		e.startSidecarLocked(e.state.agentSlug, "", false, func(err error) {
			if err != nil {
				respond <- respondErr(cmd, "pi_start_failed", err.Error())
				return
			}
			respond <- respondOK(cmd, protocol.SettingsYAMLPayload{YAML: p.YAML})
		})
		return
	}
	respond <- respondOK(cmd, protocol.SettingsYAMLPayload{YAML: p.YAML})
}
