package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jschool/coconut/internal/piadapter"
	"github.com/jschool/coconut/internal/protocol"
)

// normalizePiEvent translates one raw pi event into domain mutations
// plus backend emissions (PLAN.md §3.2.3). Actor-only.
func (e *Engine) normalizePiEvent(ev piadapter.Event) {
	switch ev.Type {

	case "agent_start":
		e.setStatus(protocol.StatusThinking, "")
		e.emitEvent(protocol.EvAgentStarted, nil, "")

	case "message_start":
		e.state.beginStream()

	case "message_update":
		var m struct {
			AssistantMessageEvent struct {
				Type  string `json:"type"`
				Delta string `json:"delta"`
			} `json:"assistantMessageEvent"`
		}
		if err := json.Unmarshal(ev.Raw, &m); err != nil {
			return
		}
		switch m.AssistantMessageEvent.Type {
		case "text_delta":
			// If thinking is still active (the provider didn't emit
			// thinking_end), finalize it now that text has begun.
			if e.state.thinking {
				e.finalizeThinkingLocked()
			}
			if !e.state.streaming {
				e.state.beginStream()
			}
			e.state.streamText += m.AssistantMessageEvent.Delta
			if e.state.agentStatus != protocol.StatusAwaitingApproval {
				e.setStatus(protocol.StatusStreaming, "")
			}
			e.emitStream(protocol.StreamAgentToken, protocol.TokenPayload{
				MessageID: e.state.streamMsgID,
				Text:      e.state.streamText,
			})
		case "thinking_delta":
			if !e.state.streaming {
				e.state.beginStream()
			}
			if !e.state.thinking {
				e.state.thinking = true
				e.state.thinkStart = time.Now()
			}
			e.state.thinkText += m.AssistantMessageEvent.Delta
			e.emitStream(protocol.StreamAgentThinking, protocol.ThinkingPayload{
				MessageID: e.state.streamMsgID,
				Text:      e.state.thinkText,
			})
		case "thinking_end":
			if e.state.thinking {
				e.finalizeThinkingLocked()
			}
		default:
			// toolcall_*, text_start/text_end, etc: not surfaced in v1 UI.
		}

	case "message_end":
		var m struct {
			Message struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(ev.Raw, &m); err != nil {
			return
		}
		if m.Message.Role != "assistant" {
			return
		}
		var parts []string
		for _, c := range m.Message.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		// Finalize any thinking that didn't get an explicit thinking_end
		// before the message closed.
		if e.state.thinking {
			e.finalizeThinkingLocked()
		}
		msg := e.state.endStream(strings.Join(parts, "\n\n"))
		if msg.ID != "" {
			e.emitEvent(protocol.EvAgentMessage, msg, "")
		}
		if e.state.agentStatus == protocol.StatusStreaming {
			e.setStatus(protocol.StatusThinking, "")
		}

	case "tool_execution_start":
		var m struct {
			ToolCallID string         `json:"toolCallId"`
			ToolName   string         `json:"toolName"`
			Args       map[string]any `json:"args"`
		}
		if err := json.Unmarshal(ev.Raw, &m); err != nil || m.ToolCallID == "" {
			return
		}
		info := toolStartInfo{ToolName: m.ToolName, Args: m.Args}
		if p, ok := m.Args["path"].(string); ok {
			info.Path = p
		}
		if c, ok := m.Args["command"].(string); ok {
			info.Command = c
		}
		if c, ok := m.Args["content"].(string); ok {
			info.Content = c
		}
		if f, ok := m.Args["file"].(string); ok {
			info.File = f
		}
		if w, ok := m.Args["what"].(string); ok {
			info.What = w
		}
		if w, ok := m.Args["why"].(string); ok {
			info.Why = w
		}
		e.state.toolArgs[m.ToolCallID] = info

		call := protocol.ToolCall{
			ID:     m.ToolCallID,
			Tool:   m.ToolName,
			Label:  toolLabel(m.ToolName, info),
			Path:   info.Path,
			What:   info.What,
			Why:    info.Why,
			Status: protocol.ToolRunning,
		}
		e.state.toolCalls = append(e.state.toolCalls, call)
		e.emitEvent(protocol.EvAgentToolStarted, call, "")

	case "tool_execution_update":
		var m struct {
			ToolCallID    string `json:"toolCallId"`
			PartialResult struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"partialResult"`
		}
		if err := json.Unmarshal(ev.Raw, &m); err != nil || m.ToolCallID == "" {
			return
		}
		var parts []string
		for _, c := range m.PartialResult.Content {
			parts = append(parts, c.Text)
		}
		e.emitStream(protocol.StreamToolOutput, protocol.ToolOutputPayload{
			ToolCallID: m.ToolCallID,
			Text:       strings.Join(parts, ""),
		})

	case "tool_execution_end":
		var m struct {
			ToolCallID string `json:"toolCallId"`
			ToolName   string `json:"toolName"`
			IsError    bool   `json:"isError"`
		}
		if err := json.Unmarshal(ev.Raw, &m); err != nil || m.ToolCallID == "" {
			return
		}
		status := protocol.ToolDone
		if m.IsError {
			status = protocol.ToolError
		}
		if call := e.state.findToolCall(m.ToolCallID); call != nil {
			// An approval may have superseded "running"; either way the
			// tool has now finished.
			call.Status = status
		}
		// A tool call that ended can no longer be approved. If its approval
		// is still pending (abort/cancel raced the dialog), auto-dismiss it
		// so neither side keeps a zombie approval around.
		if id, ok := e.dismissApprovalForToolCallLocked(m.ToolCallID); ok {
			e.emitEvent(protocol.EvApprovalResolved, protocol.ApprovalResolvedPayload{
				ApprovalID: id,
				Decision:   protocol.DecisionDismiss,
			}, "")
		}
		e.emitEvent(protocol.EvAgentToolCompleted, map[string]any{
			"toolCallId": m.ToolCallID,
			"toolName":   m.ToolName,
			"status":     status,
		}, "")

		// show_content is the fenced content channel: promote its
		// args (captured at start) into the content doc. Ungated — it
		// displays only; composed docs are staged outside the workspace
		// and file mode is read-only.
		if m.ToolName == "show_content" && !m.IsError {
			if info, ok := e.state.toolArgs[m.ToolCallID]; ok {
				e.promoteShowContent(info)
			}
		}

	case "extension_ui_request":
		e.handleExtensionUIRequest(ev.Raw)

	case "agent_end":
		// agent_settled follows when the run is truly done; nothing here.

	case "agent_settled":
		e.setStatus(protocol.StatusIdle, "")
		e.emitEvent(protocol.EvAgentCompleted, nil, "")

	case "auto_retry_start":
		var m struct {
			Attempt      int    `json:"attempt"`
			ErrorMessage string `json:"errorMessage"`
		}
		_ = json.Unmarshal(ev.Raw, &m)
		e.notify("warning", "request failed; retrying (attempt "+itoa(m.Attempt)+")")

	case "auto_retry_end":
		var m struct {
			Success    bool   `json:"success"`
			FinalError string `json:"finalError"`
		}
		_ = json.Unmarshal(ev.Raw, &m)
		if !m.Success {
			e.setStatus(protocol.StatusError, "")
			e.emitEvent(protocol.EvAgentFailed, protocol.AgentFailedPayload{
				Error:   "pi_provider_error",
				Message: m.FinalError,
			}, "")
		}

	case "compaction_start":
		e.notify("info", "compacting conversation context…")

	case "compaction_end":
		e.notify("info", "context compacted")

	case "extension_error":
		var m struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(ev.Raw, &m)
		e.notify("error", "extension error: "+m.Error)

	case "malformed_line", "malformed_response":
		e.notify("error", "protocol glitch from sidecar ("+ev.Type+")")

	default:
		// turn_start/turn_end, queue_update, bash_execution_update,
		// summarization_*: not surfaced in v1.
	}
}

// finalizeThinkingLocked marks the end of the current thinking block,
// computes its duration, and emits agent.thinking.completed.
func (e *Engine) finalizeThinkingLocked() {
	if !e.state.thinking {
		return
	}
	e.state.thinking = false
	ms := time.Since(e.state.thinkStart).Milliseconds()
	e.state.thinkMs = ms
	e.emitEvent(protocol.EvAgentThinkingCompleted, protocol.ThinkingCompletedPayload{
		MessageID:  e.state.streamMsgID,
		DurationMs: ms,
	}, "")
}

// setStatus emits agent.status.changed on transitions only.
func (e *Engine) setStatus(status, correlationID string) {
	if e.state.agentStatus == status {
		return
	}
	e.state.agentStatus = status
	e.emitEvent(protocol.EvAgentStatusChanged, map[string]string{"status": status}, correlationID)
}

// toolLabel builds the tool-log display line ("Read App.tsx" style).
func toolLabel(tool string, info toolStartInfo) string {
	name := map[string]string{
		"read":         "Read",
		"bash":         "Run",
		"run":          "Run",
		"edit":         "Edit",
		"write":        "Write",
		"grep":         "Grep",
		"find":         "Find",
		"ls":           "List",
		"propose_edit": "Edit",
		"show_content": "Show",
	}[tool]
	if name == "" {
		name = tool
	}
	switch {
	case info.Path != "":
		return name + " " + filepath.Base(info.Path)
	case info.Command != "":
		cmd := info.Command
		if len(cmd) > 40 {
			cmd = cmd[:40] + "…"
		}
		return name + " " + cmd
	default:
		return name
	}
}

// ---------------------------------------------------------------------------
// Extension UI bridging (coconut:// approval scheme)
// ---------------------------------------------------------------------------

type extUIRequest struct {
	Type    string   `json:"type"`
	ID      string   `json:"id"`
	Method  string   `json:"method"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	Options []string `json:"options"`
}

func (e *Engine) handleExtensionUIRequest(raw json.RawMessage) {
	var req extUIRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.ID == "" {
		return
	}

	// Fire-and-forget notifications pass through as notifications.
	if req.Method == "notify" {
		var m struct {
			Message    string `json:"message"`
			NotifyType string `json:"notifyType"`
		}
		_ = json.Unmarshal(raw, &m)
		level := m.NotifyType
		if level == "" {
			level = "info"
		}
		e.notify(level, m.Message)
		return
	}

	switch req.Title {
	case "coconut://propose_edit":
		e.bridgeProposeEdit(req)
	case "coconut://run":
		e.bridgeRunApproval(req)
	default:
		// Not ours (shouldn't happen with --no-extensions): dismiss
		// dialogs so nothing hangs; ignore fire-and-forget methods.
		if isDialogMethod(req.Method) {
			e.sendPiRaw(map[string]any{"type": "extension_ui_response", "id": req.ID, "cancelled": true})
		}
	}
}

func isDialogMethod(method string) bool {
	switch method {
	case "confirm", "select", "input", "editor":
		return true
	}
	return false
}

// bridgeProposeEdit turns the extension's confirm dialog into a rich
// approval request with a backend-computed diff.
func (e *Engine) bridgeProposeEdit(req extUIRequest) {
	var payload struct {
		ToolCallID string     `json:"toolCallId"`
		Path       string     `json:"path"`
		What       string     `json:"what"`
		Why        string     `json:"why"`
		Edits      []editPair `json:"edits"`
	}
	if err := json.Unmarshal([]byte(req.Message), &payload); err != nil {
		e.sendPiRaw(map[string]any{"type": "extension_ui_response", "id": req.ID, "cancelled": true})
		e.notify("error", "malformed propose_edit approval request")
		return
	}

	// Compute the display diff by applying edits in memory.
	oldContent := e.readWorkspaceFile(payload.Path)
	newContent, err := applyEdits(oldContent, payload.Edits)
	diff := ""
	if err != nil {
		diff = "(could not render diff: " + err.Error() + ")"
	} else {
		diff = buildUnifiedDiff(payload.Path, oldContent, newContent)
	}

	e.state.toolCounter++
	approval := protocol.ApprovalRequest{
		ID:    "ap-" + itoa(e.state.toolCounter),
		Kind:  protocol.ApprovalKindProposeEdit,
		Title: "Edit " + filepath.Base(payload.Path),
		Path:  payload.Path,
		What:  payload.What,
		Why:   payload.Why,
		Diff:  diff,
	}
	e.registerApprovalLocked(approval, req.ID, payload.ToolCallID)
}

func (e *Engine) bridgeRunApproval(req extUIRequest) {
	var payload struct {
		ToolCallID string `json:"toolCallId"`
		Command    string `json:"command"`
		What       string `json:"what"`
		Why        string `json:"why"`
	}
	if err := json.Unmarshal([]byte(req.Message), &payload); err != nil {
		e.sendPiRaw(map[string]any{"type": "extension_ui_response", "id": req.ID, "cancelled": true})
		e.notify("error", "malformed run approval request")
		return
	}
	e.state.toolCounter++
	approval := protocol.ApprovalRequest{
		ID:      "ap-" + itoa(e.state.toolCounter),
		Kind:    protocol.ApprovalKindBash,
		Title:   "Run command?",
		Command: payload.Command,
		What:    payload.What,
		Why:     payload.Why,
	}
	e.registerApprovalLocked(approval, req.ID, payload.ToolCallID)
}

func (e *Engine) registerApprovalLocked(approval protocol.ApprovalRequest, piReqID, toolCallID string) {
	e.state.pendingByID[approval.ID] = pendingApproval{
		request:  approval,
		piReqID:  piReqID,
		toolCall: toolCallID,
	}
	e.state.approvals = append(e.state.approvals, approval)
	if toolCallID != "" {
		if call := e.state.findToolCall(toolCallID); call != nil {
			call.Status = protocol.ToolPendingApproval
			call.ApprovalID = approval.ID
			call.What = approval.What
		}
	}
	e.setStatus(protocol.StatusAwaitingApproval, "")
	e.emitEvent(protocol.EvApprovalRequested, approval, "")
}

// readWorkspaceFile resolves a path against the workspace and reads it.
// Missing files yield "" (creation case).
func (e *Engine) readWorkspaceFile(p string) string {
	full := p
	if !filepath.IsAbs(full) {
		full = filepath.Join(e.state.workspacePath, p)
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(b)
}

// showContentMaxBytes caps file-mode renders (the panel displays the whole
// document; the extension enforces the same limit).
const showContentMaxBytes = 4 << 20

// promoteShowContent turns a completed show_content call into the panel's
// content doc. Actor-only.
//
// Mode A (path+content): the composed document comes from the tool args.
// Mode B (file): the backend reads the file off disk itself, so the file's
// contents never pass through the model's context. Relative paths resolve
// against the workspace (pi's session cwd).
func (e *Engine) promoteShowContent(info toolStartInfo) {
	if info.File != "" {
		path := info.File
		if !filepath.IsAbs(path) {
			path = filepath.Join(e.state.workspacePath, path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			e.notify("error", "show_content: cannot read "+info.File)
			return
		}
		if len(data) > showContentMaxBytes {
			e.notify("error", "show_content: "+info.File+" is too large to display")
			return
		}
		e.state.content = &protocol.ContentDoc{Path: info.File, Content: string(data), UpdatedAt: nowMs()}
		e.emitEvent(protocol.EvContentUpdated, e.state.content, "")
		return
	}
	if info.Path != "" {
		e.state.content = &protocol.ContentDoc{Path: info.Path, Content: info.Content, UpdatedAt: nowMs()}
		e.emitEvent(protocol.EvContentUpdated, e.state.content, "")
	}
}

// dismissApprovalForToolCallLocked removes a pending approval bound to a
// finished tool call. Returns the approval id if one was dismissed.
// Actor-only.
func (e *Engine) dismissApprovalForToolCallLocked(toolCallID string) (string, bool) {
	if toolCallID == "" {
		return "", false
	}
	for id, pend := range e.state.pendingByID {
		if pend.toolCall != toolCallID {
			continue
		}
		delete(e.state.pendingByID, id)
		for i, a := range e.state.approvals {
			if a.ID == id {
				e.state.approvals = append(e.state.approvals[:i], e.state.approvals[i+1:]...)
				break
			}
		}
		return id, true
	}
	return "", false
}
