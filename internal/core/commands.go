package core

import (
	"encoding/json"
	"os"

	"github.com/jschool/custard/internal/piadapter"
	"github.com/jschool/custard/internal/protocol"
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
	case protocol.CmdSessionRename:
		e.cmdSessionRename(cmd, respond)
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

func (e *Engine) cmdSessionRestore(cmd protocol.Command, respond chan []byte) {
	if e.state.workspacePath == "" {
		respond <- respondOK(cmd, map[string]any{"needsWorkspace": true})
		return
	}
	if e.piUp {
		respond <- respondOK(cmd, map[string]any{
			"needsWorkspace": false,
			"sessionName":    e.state.sessionName,
		})
		return
	}
	e.startSidecarLocked(true, func(err error) {
		if err != nil {
			respond <- respondErr(cmd, "pi_start_failed", err.Error())
			return
		}
		respond <- respondOK(cmd, map[string]any{
			"needsWorkspace": false,
			"sessionName":    e.state.sessionName,
		})
	})
}

func (e *Engine) cmdSessionRename(cmd protocol.Command, respond chan []byte) {
	var p protocol.SessionRenamePayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil || p.Name == "" {
		respond <- respondErr(cmd, "bad_payload", "session.rename needs {name}")
		return
	}
	e.state.sessionName = p.Name
	e.state.app.SessionName = p.Name
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
	e.emitEvent(protocol.EvWorkspaceChanged, e.state.workspaceInfo(), cmd.ID)

	e.startSidecarLocked(true, func(err error) {
		if err != nil {
			respond <- respondErr(cmd, "pi_start_failed", err.Error())
			return
		}
		respond <- respondOK(cmd, map[string]any{"workspace": e.state.workspaceInfo()})
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
		e.startSidecarLocked(true, func(err error) {
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
