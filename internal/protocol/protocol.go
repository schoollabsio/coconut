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
	CmdSessionRestore   = "session.restore" // startup bootstrap: reopen last agent
	CmdAgentOpen        = "agent.open"      // open an agent (+ optional session)
	CmdAgentRename      = "agent.rename"
	CmdAgentReset       = "agent.reset"    // new underlying pi session, same agent
	CmdAgentList        = "agent.list"     // scan workspace agents + sessions
	CmdWorkspacePick    = "workspace.pick" // opens native dir picker
	CmdWorkspaceSet     = "workspace.set"
	CmdAgentStart       = "agent.start"
	CmdAgentCancel      = "agent.cancel"
	CmdApprovalRespond  = "agent.approval.respond"
	CmdSettingsGet      = "settings.get"
	CmdSettingsSave     = "settings.save"
	CmdSettingsValidate = "settings.validate"
	CmdWindowNew        = "window.new" // open an agent in a NEW window
	CmdDiagnostics      = "diagnostics.log" // TEMP: frontend reports UI lifecycle for flicker debugging

	// Auth (provider credentials via the coconut-login helper).
	CmdAuthStatus      = "auth.status"       // providers + credential status
	CmdAuthLogin       = "auth.login"        // start an OAuth/API-key login (async; progress via events)
	CmdAuthLoginPrompt = "auth.login.prompt" // answer a login prompt (or cancel it)
	CmdAuthLoginCancel = "auth.login.cancel" // abort an in-flight login
	CmdAuthLogout      = "auth.logout"       // remove a provider credential
	CmdAuthSetApiKey   = "auth.set_api_key"  // store an API key credential
	CmdAuthModels      = "auth.models"       // models usable with current credentials
)

// ---------------------------------------------------------------------------
// Event names (PLAN.md §6.2, v1 subset)
// ---------------------------------------------------------------------------

const (
	EvSessionRestored        = "session.restored" // agent opened / session switched
	EvWorkspaceChanged       = "workspace.changed"
	EvAgentReset             = "agent.session.reset" // new session started in place
	EvAgentStarted           = "agent.started"
	EvAgentStatusChanged     = "agent.status.changed"
	EvAgentMessage           = "agent.message.appended"
	EvAgentToolStarted       = "agent.tool.started"
	EvAgentToolCompleted     = "agent.tool.completed"
	EvApprovalRequested      = "agent.approval.requested"
	EvApprovalResolved       = "agent.approval.resolved"
	EvAgentCompleted         = "agent.completed"
	EvAgentFailed            = "agent.failed"
	EvSidecarLost            = "agent.sidecar.lost"
	EvContentUpdated         = "content.updated"
	EvWindowStateChanged     = "window.state.changed"
	EvSettingsChanged        = "settings.changed"
	EvNotification           = "notification.created"
	EvAgentThinkingCompleted = "agent.thinking.completed"

	// Auth login flow (all carry a loginId; the frontend renders the
	// steps as they arrive).
	EvAuthLoginStarted   = "auth.login.started"
	EvAuthLoginStep      = "auth.login.step"      // helper notify event (info/auth_url/device_code/progress)
	EvAuthLoginPrompt    = "auth.login.prompt"    // helper prompt (text/secret/select/manual_code)
	EvAuthLoginCompleted = "auth.login.completed"
	EvAuthLoginCancelled = "auth.login.cancelled"
	EvAuthLoginFailed    = "auth.login.failed"
)

// Stream (unsequenced) names.
const (
	StreamAgentToken    = "agent.token" // payload: TokenPayload (cumulative)
	StreamToolOutput    = "agent.tool.output"
	StreamAgentThinking = "agent.thinking" // payload: ThinkingPayload (cumulative)
)

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

type AgentRenamePayload struct {
	Name string `json:"name"`
}

// AgentOpenPayload selects an agent (by slug, or by name for a new agent)
// and optionally a specific session. New=true starts a fresh session even
// if the agent has a restorable one.
type AgentOpenPayload struct {
	Slug        string `json:"slug,omitempty"`
	Name        string `json:"name,omitempty"` // for "new agent": slugified server-side
	SessionFile string `json:"sessionFile,omitempty"`
	New         bool   `json:"new,omitempty"`
}

// AgentSummary is one agent in a workspace scan.
type AgentSummary struct {
	Slug     string           `json:"slug"`
	Name     string           `json:"name"`
	Current  bool             `json:"current"`
	Sessions []SessionSummary `json:"sessions"`
}

// SessionSummary is one transcript in a workspace scan.
type SessionSummary struct {
	File       string `json:"file"`
	StartedAt  string `json:"startedAt"`  // RFC3339, from the session header
	ModifiedAt string `json:"modifiedAt"` // RFC3339, file mtime (last activity)
	SizeBytes  int64  `json:"sizeBytes"`
	Preview    string `json:"preview,omitempty"` // first user message, truncated
	Current    bool   `json:"current"`
}

type WorkspaceSetPayload struct {
	Path string `json:"path"`
}

// WindowNewPayload opens a sibling window booted to the given agent in the
// given workspace (same or different from the caller's).
type WindowNewPayload struct {
	Workspace   string `json:"workspace"`
	AgentSlug   string `json:"agentSlug"`
	AgentName   string `json:"agentName,omitempty"`   // window title
	SessionFile string `json:"sessionFile,omitempty"` // specific session (optional)
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
// Auth (login helper) payloads
// ---------------------------------------------------------------------------

// AuthType values for auth.login.
const (
	AuthTypeOAuth  = "oauth"
	AuthTypeAPIKey = "api_key"
)

type AuthLoginStartPayload struct {
	Provider string `json:"provider"`
	AuthType string `json:"authType"` // AuthTypeOAuth | AuthTypeAPIKey
}

// AuthLoginPromptPayload answers a login prompt. Cancel=true (or empty
// value) dismisses the step.
type AuthLoginPromptPayload struct {
	PromptID string `json:"promptId"`
	Value    string `json:"value,omitempty"`
	Cancel   bool   `json:"cancel,omitempty"`
}

type AuthLoginCancelPayload struct {
	LoginID string `json:"loginId"`
}

type AuthProviderPayload struct {
	Provider string `json:"provider"`
}

type AuthSetApiKeyPayload struct {
	Provider string `json:"provider"`
	Key      string `json:"key"`
}

type AuthModelsPayload struct {
	Provider string `json:"provider,omitempty"` // empty = all providers
}

// AuthProviderStatus is one provider in auth.status results.
type AuthProviderStatus struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	OAuth  bool   `json:"oauth"`  // offers OAuth login
	APIKey bool   `json:"apiKey"` // offers API-key entry
	Configured bool `json:"configured"`
	Source     string `json:"source,omitempty"` // e.g. "OAuth", "ANTHROPIC_API_KEY"
	Type       string `json:"type,omitempty"`   // "oauth" | "api_key"
}

type AuthStatusResult struct {
	Providers    []AuthProviderStatus `json:"providers"`
	Credentials  []CredentialInfo     `json:"credentials"`
	ActiveProvider string             `json:"activeProvider,omitempty"`
}

type CredentialInfo struct {
	ProviderID string `json:"providerId"`
	Type       string `json:"type"` // "oauth" | "api_key"
}

type AuthModel struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	Reasoning     bool   `json:"reasoning,omitempty"`
}

// ---------------------------------------------------------------------------
// Domain view models (event payloads + snapshot state)
// ---------------------------------------------------------------------------

// AgentStatus values - full granularity for all agent phases (Option E).
// The 'thinking' and 'streaming' statuses are kept for backward compatibility
// but internally we use 'reasoning' and 'generating' for clarity.
const (
	StatusIdle                   = "idle"
	StatusReasoning              = "reasoning"     // was 'thinking'
	StatusGenerating             = "generating"    // was 'streaming'
	StatusRunningTool            = "running_tool"  // NEW: tool executing without approval
	StatusAwaitingToolApproval   = "awaiting_tool_approval" // NEW: tool needs approval
	StatusAwaitingApprovalLegacy = "awaiting_approval"      // deprecated, for backward compat
	StatusError                  = "error"
)

// Status aliases for backward compatibility with existing code.
// These map the old names to the new semantic names.
const (
	StatusThinking               = StatusReasoning  // alias
	StatusStreaming              = StatusGenerating // alias
	StatusAwaitingApprovalCompat = StatusAwaitingToolApproval // for approval workflows
	StatusAwaitingApproval       = StatusAwaitingApprovalLegacy // backward compat
)

type ChatMessage struct {
	ID           string `json:"id"`
	Role         string `json:"role"` // "user" | "assistant"
	Text         string `json:"text"`
	Streaming    bool   `json:"streaming,omitempty"`
	Thinking     string `json:"thinking,omitempty"`     // accumulated reasoning content
	ThinkingDone bool   `json:"thinkingDone,omitempty"` // thinking block has ended
	ThinkingMs   int64  `json:"thinkingMs,omitempty"`   // duration of reasoning in milliseconds
}

// Tool call statuses.
const (
	ToolRunning           = "running"
	ToolDone              = "done"
	ToolError             = "error"
	ToolPendingApproval   = "pending_approval"
)

// Tool phases for status emission during tool execution.
const (
	ToolApprovalReasonEdit  = "propose_edit"
	ToolApprovalReasonBash  = "bash"
	ToolReasonRun           = "run"
	ToolReasonTool          = "tool"
)

// Helper function to determine if a tool call needs approval.
func NeedApproval(tool string) bool {
	switch tool {
	case "bash", "run", "propose_edit":
		return true
	default:
		return false
	}
}

type ToolCall struct {
	ID         string `json:"id"`
	Tool       string `json:"tool"`           // pi toolName: read, run, propose_edit, show_content, …
	Label      string `json:"label"`          // display line, e.g. "Read App.tsx"
	Path       string `json:"path,omitempty"` // primary file, if any
	What       string `json:"what,omitempty"` // approval's action description, if any
	Why        string `json:"why,omitempty"`  // rationale for the tool call, if provided
	Status     string `json:"status"`
	ApprovalID string `json:"approvalId,omitempty"`
	GroupLabel string `json:"groupLabel,omitempty"` // agent-assigned label for tool call grouping
}

// Approval kinds.
const (
	ApprovalKindProposeEdit = "propose_edit"
	ApprovalKindBash        = "bash"
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
}

type ApprovalResolvedPayload struct {
	ApprovalID string `json:"approvalId"`
	Decision   string `json:"decision"`
}

type ContentDoc struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Format    string `json:"format"`    // "markdown" (default) | "html"
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
	AgentName        string            `json:"agentName"`
	AgentSlug        string            `json:"agentSlug"`
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

// ThinkingPayload carries the CUMULATIVE reasoning content of the in-flight
// assistant message (parallel to TokenPayload for text).

type ThinkingPayload struct {
	MessageID string `json:"messageId"`
	Text      string `json:"text"` // cumulative reasoning text
}

// ThinkingCompletedPayload is emitted when a thinking block ends, reporting
// how long the reasoning took so the UI can render "Thought for X seconds".

type ThinkingCompletedPayload struct {
	MessageID  string `json:"messageId"`
	DurationMs int64  `json:"durationMs"`
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

type WindowStatePayload struct {
	Fullscreen bool `json:"fullscreen"`
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
