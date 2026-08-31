// Package protocol defines the shared command/event/snapshot envelope
// types exchanged between the Go backend and the React frontend.
//
// See PLAN.md §4-5. The v1 surface is a subset of the plan's catalog
// (no terminals/git/tabs yet). Two deliberate refinements:
//
//   - Stream messages (agent.token, agent.tool.output) carry CUMULATIVE
//     text for the in-flight item, not raw deltas. Transport is local,
//     so bandwidth is irrelevant and cumulative payloads are
//     self-healing if a stream message is dropped.
//   - Approval decisions are "allow" | "dismiss" (approve-only UX;
//     rejection is conversational via chat).
package protocol

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Envelopes (PLAN.md §5.2)
// ---------------------------------------------------------------------------

// Command is a request from frontend to backend.
type Command struct {
	Type    string          `json:"type"` // always "command"
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// CommandResponse answers a Command. Domain failures are reported
// in-envelope via Error; transport-level failures never reach here.
type CommandResponse struct {
	Type      string     `json:"type"` // always "command_response"
	CommandID string     `json:"commandId"`
	OK        bool       `json:"ok"`
	Payload   any        `json:"payload,omitempty"`
	Error     *ErrorInfo `json:"error,omitempty"`
}

type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Event is a sequenced fact emitted by the backend (PLAN.md §5.5).
type Event struct {
	Type          string `json:"type"` // always "event"
	Seq           uint64 `json:"seq"`
	Name          string `json:"name"`
	Payload       any    `json:"payload,omitempty"`
	Timestamp     int64  `json:"timestamp"` // unix ms
	CorrelationID string `json:"correlationId,omitempty"`
}

// Stream is a high-frequency, unsequenced message (PLAN.md §5.8).
// Payloads are cumulative for the in-flight item (see package doc).
type Stream struct {
	Type    string `json:"type"` // always "stream"
	Name    string `json:"name"`
	Payload any    `json:"payload,omitempty"`
}

// Snapshot replaces backend-derived frontend state (PLAN.md §5.6).
type Snapshot struct {
	Type  string        `json:"type"` // always "snapshot"
	Seq   uint64        `json:"seq"`
	State SnapshotState `json:"state"`
}

// ErrorMessage is a standalone backend error (PLAN.md §5.7).
type ErrorMessage struct {
	Type    string `json:"type"` // always "error"
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ---------------------------------------------------------------------------
// Command names (PLAN.md §6.1, v1 subset)
// ---------------------------------------------------------------------------

const (
	CmdSessionRestore  = "session.restore"
	CmdSessionRename   = "session.rename"
	CmdWorkspacePick   = "workspace.pick" // opens native dir picker
	CmdWorkspaceSet    = "workspace.set"
	CmdAgentStart      = "agent.start"
	CmdAgentCancel     = "agent.cancel"
	CmdApprovalRespond = "agent.approval.respond"
	CmdSettingsGet      = "settings.get"
	CmdSettingsSave     = "settings.save"
	CmdSettingsValidate = "settings.validate"
)

// ---------------------------------------------------------------------------
// Event names (PLAN.md §6.2, v1 subset)
// ---------------------------------------------------------------------------

const (
	EvSessionRestored    = "session.restored"
	EvWorkspaceChanged   = "workspace.changed"
	EvAgentStarted       = "agent.started"
	EvAgentStatusChanged = "agent.status.changed"
	EvAgentMessage       = "agent.message.appended"
	EvAgentToolStarted   = "agent.tool.started"
	EvAgentToolCompleted = "agent.tool.completed"
	EvApprovalRequested  = "agent.approval.requested"
	EvApprovalResolved   = "agent.approval.resolved"
	EvAgentCompleted     = "agent.completed"
	EvAgentFailed        = "agent.failed"
	EvSidecarLost        = "agent.sidecar.lost"
	EvContentUpdated     = "content.updated"
	EvSettingsChanged    = "settings.changed"
	EvNotification       = "notification.created"
)

// Stream (unsequenced) names.
const (
	StreamAgentToken = "agent.token" // payload: TokenPayload (cumulative)
	StreamToolOutput = "agent.tool.output"
)

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

type SessionRenamePayload struct {
	Name string `json:"name"`
}

type WorkspaceSetPayload struct {
	Path string `json:"path"`
}

type AgentStartPayload struct {
	Prompt string `json:"prompt"`
}

// Approval decisions.
const (
	DecisionAllow   = "allow"
	DecisionDismiss = "dismiss"
)

type ApprovalRespondPayload struct {
	ApprovalID string `json:"approvalId"`
	Decision   string `json:"decision"` // DecisionAllow | DecisionDismiss
}

// SettingsYAMLPayload carries the raw settings.yaml text. The frontend
// edits YAML directly; the backend owns parsing and validation.
type SettingsYAMLPayload struct {
	YAML string `json:"yaml"`
}

type SettingsSavePayload struct {
	YAML string `json:"yaml"`
}

type SettingsValidatePayload struct {
	YAML string `json:"yaml"`
}

// ConfigProblem is one settings validation finding; "error" blocks saving,
// "warning" is informational.
type ConfigProblem struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type SettingsValidateResult struct {
	Valid    bool            `json:"valid"`
	Problems []ConfigProblem `json:"problems"`
}

// ---------------------------------------------------------------------------
// Domain view models (event payloads + snapshot state)
// ---------------------------------------------------------------------------

// AgentStatus values.
const (
	StatusIdle             = "idle"
	StatusThinking         = "thinking"
	StatusStreaming        = "streaming"
	StatusAwaitingApproval = "awaiting_approval"
	StatusError            = "error"
)

type ChatMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"` // "user" | "assistant"
	Text      string `json:"text"`
	Streaming bool   `json:"streaming,omitempty"`
}

// Tool call statuses.
const (
	ToolRunning         = "running"
	ToolDone            = "done"
	ToolError           = "error"
	ToolPendingApproval = "pending_approval"
)

type ToolCall struct {
	ID         string `json:"id"`
	Tool       string `json:"tool"`           // pi toolName: read, bash, propose_edit, write_content, …
	Label      string `json:"label"`          // display line, e.g. "Read App.tsx"
	Path       string `json:"path,omitempty"` // primary file, if any
	Status     string `json:"status"`
	ApprovalID string `json:"approvalId,omitempty"`
}

// Approval kinds.
const (
	ApprovalKindProposeEdit  = "propose_edit"
	ApprovalKindBash         = "bash"
	ApprovalKindWriteContent = "write_content"
)

type ApprovalRequest struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // ApprovalKind*
	Title string `json:"title"`
	// propose_edit:
	Path string `json:"path,omitempty"`
	What string `json:"what,omitempty"`
	Why  string `json:"why,omitempty"`
	Diff string `json:"diff,omitempty"` // unified diff text, rendered line-wise
	// bash:
	Command string `json:"command,omitempty"`
	// write_content: full document body; promoted to the content panel
	// only if the user approves.
	Content string `json:"content,omitempty"`
}

type ApprovalResolvedPayload struct {
	ApprovalID string `json:"approvalId"`
	Decision   string `json:"decision"`
}

type ContentDoc struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	UpdatedAt int64  `json:"updatedAt"` // unix ms
}

type WorkspaceInfo struct {
	Path string `json:"path"`
	Name string `json:"name"` // base name of the directory
}

type AgentState struct {
	Status    string        `json:"status"`
	Messages  []ChatMessage `json:"messages"`
	ToolCalls []ToolCall    `json:"toolCalls"`
}

// SnapshotState is the backend-derivable state tree (PLAN.md §4.4, v1 subset).
type SnapshotState struct {
	SessionName      string            `json:"sessionName"`
	Workspace        WorkspaceInfo     `json:"workspace"`
	Agent            AgentState        `json:"agent"`
	Content          *ContentDoc       `json:"content"`
	PendingApprovals []ApprovalRequest `json:"pendingApprovals"`
	SettingsYAML     string            `json:"settingsYaml"`
}

// ---------------------------------------------------------------------------
// Stream payloads
// ---------------------------------------------------------------------------

// TokenPayload carries the CUMULATIVE text of the in-flight assistant
// message (see package doc).
type TokenPayload struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"`
}

type ToolOutputPayload struct {
	ToolCallID string `json:"toolCallId"`
	Text       string `json:"text"` // cumulative partial output
}

// ---------------------------------------------------------------------------
// Misc event payloads
// ---------------------------------------------------------------------------

type AgentFailedPayload struct {
	Error   string `json:"error"`   // stable code, e.g. "pi_internal_error"
	Message string `json:"message"` // human-readable
}

type NotificationPayload struct {
	Level   string `json:"level"` // "info" | "warning" | "error"
	Message string `json:"message"`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ParseCommand decodes a serialized command envelope.
func ParseCommand(raw []byte) (Command, error) {
	var c Command
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("invalid command envelope: %w", err)
	}
	if c.Type != "command" || c.ID == "" || c.Name == "" {
		return c, fmt.Errorf("malformed command envelope (type/id/name)")
	}
	return c, nil
}

// OKResponse / ErrResponse build command_response envelopes.
func OKResponse(commandID string, payload any) CommandResponse {
	return CommandResponse{Type: "command_response", CommandID: commandID, OK: true, Payload: payload}
}

func ErrResponse(commandID, code, message string) CommandResponse {
	return CommandResponse{
		Type:      "command_response",
		CommandID: commandID,
		OK:        false,
		Error:     &ErrorInfo{Code: code, Message: message},
	}
}
