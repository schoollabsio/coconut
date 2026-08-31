package core

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/jschool/custard/internal/protocol"
)

// domainState is owned exclusively by the actor goroutine.
type domainState struct {
	settings    Settings // parsed settings.yaml
	settingsRaw string   // raw YAML text (round-trips comments)
	app         appState // persisted app bookkeeping (state.json)

	workspacePath string
	sessionName   string

	agentStatus string
	messages    []protocol.ChatMessage
	toolCalls   []protocol.ToolCall
	content     *protocol.ContentDoc
	approvals   []protocol.ApprovalRequest

	// streaming assistant message assembly
	streamMsgID string
	streamText  string
	streaming   bool
	msgCounter  int
	toolCounter int

	// pi-side correlation
	toolArgs    map[string]toolStartInfo // toolCallId → args snapshot
	pendingByID map[string]pendingApproval
}

type toolStartInfo struct {
	ToolName string
	Path     string
	Command  string
	Content  string // show_content payload
	Args     map[string]any
}

// pendingApproval ties a frontend approval to the pi dialog request.
type pendingApproval struct {
	request  protocol.ApprovalRequest
	piReqID  string // extension_ui_request id
	toolCall string // toolCallId, may be empty
}

func newDomainState() *domainState {
	return &domainState{
		agentStatus: protocol.StatusIdle,
		toolArgs:    map[string]toolStartInfo{},
		pendingByID: map[string]pendingApproval{},
	}
}

// resetAgent clears per-run conversational state (new session/workspace).
func (s *domainState) resetAgent() {
	s.agentStatus = protocol.StatusIdle
	s.messages = nil
	s.toolCalls = nil
	s.approvals = nil
	s.streamMsgID = ""
	s.streamText = ""
	s.streaming = false
	s.toolArgs = map[string]toolStartInfo{}
	s.pendingByID = map[string]pendingApproval{}
}

func (s *domainState) workspaceInfo() protocol.WorkspaceInfo {
	return protocol.WorkspaceInfo{
		Path: s.workspacePath,
		Name: filepath.Base(s.workspacePath),
	}
}

func (s *domainState) snapshot() protocol.SnapshotState {
	msgs := make([]protocol.ChatMessage, len(s.messages))
	copy(msgs, s.messages)
	if s.streaming {
		// Include the in-flight assistant message so a resyncing
		// frontend sees partial text.
		msgs = append(msgs, protocol.ChatMessage{
			ID:        s.streamMsgID,
			Role:      "assistant",
			Text:      s.streamText,
			Streaming: true,
		})
	}
	calls := make([]protocol.ToolCall, len(s.toolCalls))
	copy(calls, s.toolCalls)
	appr := make([]protocol.ApprovalRequest, len(s.approvals))
	copy(appr, s.approvals)
	var content *protocol.ContentDoc
	if s.content != nil {
		c := *s.content
		content = &c
	}
	return protocol.SnapshotState{
		SessionName:      s.sessionName,
		Workspace:        s.workspaceInfo(),
		Agent:            protocol.AgentState{Status: s.agentStatus, Messages: msgs, ToolCalls: calls},
		Content:          content,
		PendingApprovals: appr,
		SettingsYAML:     s.settingsRaw,
	}
}

// --- message helpers (actor-only) ---

func (s *domainState) appendMessage(role, text string) protocol.ChatMessage {
	s.msgCounter++
	msg := protocol.ChatMessage{
		ID:   msgID(s.msgCounter),
		Role: role,
		Text: text,
	}
	s.messages = append(s.messages, msg)
	return msg
}

func (s *domainState) beginStream() {
	if s.streaming {
		return
	}
	s.msgCounter++
	s.streamMsgID = msgID(s.msgCounter)
	s.streamText = ""
	s.streaming = true
}

func (s *domainState) endStream(finalText string) protocol.ChatMessage {
	if !s.streaming {
		return protocol.ChatMessage{}
	}
	s.streaming = false
	s.streamText = ""
	if strings.TrimSpace(finalText) == "" {
		// Tool-call-only assistant turns carry no prose; emitting them
		// would render an empty bubble (just the ✦ icon) in the chat.
		return protocol.ChatMessage{}
	}
	msg := protocol.ChatMessage{
		ID:   s.streamMsgID,
		Role: "assistant",
		Text: finalText,
	}
	s.messages = append(s.messages, msg)
	return msg
}

func msgID(n int) string {
	return "m" + itoa(n)
}

// --- tool call helpers ---

func (s *domainState) findToolCall(id string) *protocol.ToolCall {
	for i := range s.toolCalls {
		if s.toolCalls[i].ID == id {
			return &s.toolCalls[i]
		}
	}
	return nil
}

func nowMs() int64 { return time.Now().UnixMilli() }

// itoa avoids importing strconv in multiple files.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
