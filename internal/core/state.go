package core

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/jschool/coconut/internal/protocol"
)

// domainState is owned exclusively by the actor goroutine.
type domainState struct {
	settings    Settings // parsed settings.yaml
	settingsRaw string   // raw YAML text (round-trips comments)
	app         appState // persisted app bookkeeping (state.json)

	workspacePath string
	agentSlug     string
	agentName     string

	agentStatus string
	messages    []protocol.ChatMessage
	toolCalls   []protocol.ToolCall
	content     *protocol.ContentDoc
	// contentLibrary caches the agent's content-dir scan (newest first).
	// Cleared by resetAgent; every sidecar (re)start and agent.reset
	// rescans it from disk.
	contentLibrary []protocol.ContentEntry
	approvals      []protocol.ApprovalRequest

	// streaming assistant message assembly
	streamMsgID string
	streamText  string
	streaming   bool
	msgCounter  int
	toolCounter int
	timelineSeq int64

	// reasoning content assembly (parallel to text streaming above)
	thinkText  string
	thinkStart time.Time
	thinking   bool
	thinkMs    int64

	// pi-side correlation
	toolArgs          map[string]toolStartInfo // toolCallId → args snapshot
	pendingByID       map[string]pendingApproval
	restoredToolCalls []restoredToolCall
}

type toolStartInfo struct {
	ToolName   string
	Path       string
	Command    string
	What       string // tool call's action description, if provided
	Why        string // tool call's rationale, if provided
	Content    string // show_content composed-document payload
	File       string // show_content render-an-existing-file payload
	Format     string // show_content display format: "markdown" (default) | "html"
	GroupLabel string // agent-assigned label for tool call grouping
	Args       map[string]any
}

type restoredToolCall struct {
	call           protocol.ToolCall
	messageOrdinal int // 1-based assistant message ordinal; 0 = orphan/best-effort append
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
	s.contentLibrary = nil
	s.streamMsgID = ""
	s.streamText = ""
	s.streaming = false
	s.toolArgs = map[string]toolStartInfo{}
	s.pendingByID = map[string]pendingApproval{}
	s.restoredToolCalls = nil
	s.timelineSeq = 0
	s.thinkText = ""
	s.thinkStart = time.Time{}
	s.thinking = false
	s.thinkMs = 0
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
			ID:           s.streamMsgID,
			Seq:          s.timelineSeq + 1,
			Role:         "assistant",
			Text:         s.streamText,
			Streaming:    true,
			Thinking:     s.thinkText,
			ThinkingDone: !s.thinking,
			ThinkingMs:   s.thinkMs,
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
	library := make([]protocol.ContentEntry, len(s.contentLibrary))
	copy(library, s.contentLibrary)
	return protocol.SnapshotState{
		AgentName:        s.agentName,
		AgentSlug:        s.agentSlug,
		Workspace:        s.workspaceInfo(),
		Agent:            protocol.AgentState{Status: s.agentStatus, Messages: msgs, ToolCalls: calls},
		Content:          content,
		ContentLibrary:   library,
		PendingApprovals: appr,
		SettingsYAML:     s.settingsRaw,
	}
}

// --- message helpers (actor-only) ---

func (s *domainState) appendMessage(role, text string) protocol.ChatMessage {
	s.msgCounter++
	msg := protocol.ChatMessage{
		ID:   msgID(s.msgCounter),
		Seq:  s.nextTimelineSeq(),
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
	s.thinkText = ""
	s.thinkStart = time.Time{}
	s.thinking = false
	s.thinkMs = 0
}

func (s *domainState) endStream(finalText string) protocol.ChatMessage {
	if !s.streaming {
		return protocol.ChatMessage{}
	}
	s.streaming = false
	s.streamText = ""
	thinkText := s.thinkText
	thinkMs := s.thinkMs
	thinking := s.thinking
	// Finalize thinking if it hasn't been ended already.
	if thinking {
		thinkMs = time.Since(s.thinkStart).Milliseconds()
		s.thinking = false
	}
	s.thinkText = ""
	s.thinkStart = time.Time{}
	s.thinkMs = 0
	if strings.TrimSpace(finalText) == "" {
		if thinkText == "" {
			// Tool-call-only assistant turns carry no prose; emitting them
			// would render an empty bubble (just the ✦ icon) in the chat.
			return protocol.ChatMessage{}
		}
		// Reasoning-only turn (thinking, then tool calls with no prose):
		// keep the reasoning in history so a snapshot/resync shows the
		// same "Thought for Ns" block the live stream showed. The chat
		// renders text-less thinking messages as a collapsed header,
		// never an empty bubble.
		msg := protocol.ChatMessage{
			ID:           s.streamMsgID,
			Seq:          s.nextTimelineSeq(),
			Role:         "assistant",
			Thinking:     thinkText,
			ThinkingDone: true,
			ThinkingMs:   thinkMs,
		}
		s.messages = append(s.messages, msg)
		return msg
	}
	msg := protocol.ChatMessage{
		ID:           s.streamMsgID,
		Seq:          s.nextTimelineSeq(),
		Role:         "assistant",
		Text:         finalText,
		Thinking:     thinkText,
		ThinkingDone: true,
		ThinkingMs:   thinkMs,
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

func (s *domainState) nextTimelineSeq() int64 {
	s.timelineSeq++
	return s.timelineSeq
}

func (s *domainState) resequenceRestoredTimeline() {
	next := int64(0)
	assistantOrdinal := 0
	grouped := map[int][]protocol.ToolCall{}
	emitted := map[string]struct{}{}
	for _, item := range s.restoredToolCalls {
		if item.messageOrdinal > 0 {
			grouped[item.messageOrdinal] = append(grouped[item.messageOrdinal], item.call)
		}
	}
	calls := make([]protocol.ToolCall, 0, len(s.restoredToolCalls))
	for i := range s.messages {
		next++
		s.messages[i].Seq = next
		if s.messages[i].Role != "assistant" {
			continue
		}
		assistantOrdinal++
		if items := grouped[assistantOrdinal]; len(items) > 0 {
			for j := range items {
				next++
				items[j].Seq = next
				calls = append(calls, items[j])
				emitted[items[j].ID] = struct{}{}
			}
		}
	}
	for _, item := range s.restoredToolCalls {
		if _, ok := emitted[item.call.ID]; ok {
			continue
		}
		next++
		item.call.Seq = next
		calls = append(calls, item.call)
	}
	s.toolCalls = calls
	s.timelineSeq = next
	s.restoredToolCalls = nil
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
