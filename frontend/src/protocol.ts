/**
 * Mirror of internal/protocol/protocol.go — keep in sync manually.
 * See PLAN.md §4-5 and the Go package doc for semantic notes
 * (cumulative stream payloads; approve-only decisions).
 */

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface Command {
  type: 'command'
  id: string
  name: string
  payload?: unknown
}

export interface CommandResponse<T = unknown> {
  type: 'command_response'
  commandId: string
  ok: boolean
  payload?: T
  error?: { code: string; message: string }
}

export interface BackendEvent<T = unknown> {
  type: 'event'
  seq: number
  name: string
  payload?: T
  timestamp: number
  correlationId?: string
}

export interface StreamMessage<T = unknown> {
  type: 'stream'
  name: string
  payload?: T
}

export interface SnapshotMessage {
  type: 'snapshot'
  seq: number
  state: SnapshotState
  /** The calling window's name — the sender tag for 'backend' events.
   *  v3 broadcasts custom events to every window; the store drops
   *  envelopes whose sender is not this window. */
  windowName?: string
}

export interface ErrorMessage {
  type: 'error'
  code: string
  message: string
}

export type BackendMessage = BackendEvent | StreamMessage | SnapshotMessage | ErrorMessage

// ---------------------------------------------------------------------------
// Command names
// ---------------------------------------------------------------------------

export const Cmd = {
  SessionRestore: 'session.restore',
  AgentOpen: 'agent.open',
  AgentRename: 'agent.rename',
  AgentReset: 'agent.reset',
  AgentList: 'agent.list',
  WorkspacePick: 'workspace.pick',
  WorkspaceSet: 'workspace.set',
  AgentStart: 'agent.start',
  AgentCancel: 'agent.cancel',
  ApprovalRespond: 'agent.approval.respond',
  SettingsGet: 'settings.get',
  SettingsSave: 'settings.save',
  SettingsValidate: 'settings.validate',
  WindowNew: 'window.new',
  Diagnostics: 'diagnostics.log',
} as const

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const Ev = {
  SessionRestored: 'session.restored',
  WorkspaceChanged: 'workspace.changed',
  AgentReset: 'agent.session.reset',
  AgentStarted: 'agent.started',
  AgentStatusChanged: 'agent.status.changed',
  AgentMessage: 'agent.message.appended',
  AgentToolStarted: 'agent.tool.started',
  AgentToolCompleted: 'agent.tool.completed',
  ApprovalRequested: 'agent.approval.requested',
  ApprovalResolved: 'agent.approval.resolved',
  AgentCompleted: 'agent.completed',
  AgentFailed: 'agent.failed',
  SidecarLost: 'agent.sidecar.lost',
  ContentUpdated: 'content.updated',
  WindowStateChanged: 'window.state.changed',
  SettingsChanged: 'settings.changed',
  Notification: 'notification.created',
  AgentThinkingCompleted: 'agent.thinking.completed',
} as const

export const Stream = {
  AgentToken: 'agent.token',
  ToolOutput: 'agent.tool.output',
  AgentThinking: 'agent.thinking',
} as const

// ---------------------------------------------------------------------------
// Domain view models
// ---------------------------------------------------------------------------

// AgentStatus values - full granularity for all agent phases (Option E).
// Kept for backward compatibility but extended for tool execution phases.
export type AgentStatus = 'idle' | 'reasoning' | 'generating' | 'running_tool' | 'awaiting_tool_approval' | 'error'

// Status constants for easier comparison.
export const Status = {
  Idle: 'idle',
  Reasoning: 'reasoning',
  Generating: 'generating',
  RunningTool: 'running_tool',
  AwaitingToolApproval: 'awaiting_tool_approval',
  Error: 'error',
} as const

/** @deprecated Use Status.Reasoning or status === 'reasoning' */
export const StatusThinking = 'reasoning'

/** @deprecated Use Status.Generating or status === 'generating' */
export const StatusStreaming = 'generating'

// AgentStatus type already exported above
// Re-export helper functions: isBusy, isToolStatus, getStatusLabel

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  thinking?: string
  thinkingDone?: boolean
  thinkingMs?: number
}

export type ToolCallStatus = 'running' | 'done' | 'error' | 'pending_approval'

export interface ToolCall {
  id: string
  tool: string
  label: string
  path?: string
  what?: string
  why?: string
  status: ToolCallStatus
  approvalId?: string
  groupLabel?: string // agent-assigned label for tool call grouping
}

export interface ApprovalRequest {
  id: string
  kind: 'propose_edit' | 'bash'
  title: string
  path?: string
  what?: string
  why?: string
  diff?: string
  command?: string
}

export interface ContentDoc {
  path: string
  content: string
  format?: 'markdown' | 'html'
  updatedAt: number
}

export interface WorkspaceInfo {
  path: string
  name: string
}

/** One settings validation finding; "error" blocks saving. */
export interface ConfigProblem {
  severity: 'error' | 'warning'
  message: string
}

export interface SettingsValidateResult {
  valid: boolean
  problems: ConfigProblem[]
}

/** window.new payload: open a sibling window booted to the given agent. */
export interface WindowNewPayload {
  workspace: string
  agentSlug: string
  agentName?: string
  sessionFile?: string
}

/** settings.get response / settings.save request+response payload. */
export interface SettingsYAML {
  yaml: string
}

export interface AgentState {
  status: AgentStatus
  messages: ChatMessage[]
  toolCalls: ToolCall[]
}

// Helper to check if status indicates the agent is busy.
export function isBusy(status: AgentStatus): boolean {
  return status !== 'idle' && status !== 'error'
}

// Helper to check if status indicates tool execution.
export function isToolStatus(status: AgentStatus): boolean {
  return status === 'running_tool' || status === 'awaiting_tool_approval'
}

// Helper to get the loading label for a status.
export function getStatusLabel(status: AgentStatus): string {
  switch (status) {
    case 'reasoning':
      return 'Thinking...'
    case 'generating':
      return 'Generating...'
    case 'running_tool':
      return 'Tool running...'
    case 'awaiting_tool_approval':
      return 'waiting for your approval...'
    default:
      return ''
  }
}

export interface SnapshotState {
  agentName: string
  agentSlug: string
  workspace: WorkspaceInfo
  agent: AgentState
  content: ContentDoc | null
  pendingApprovals: ApprovalRequest[]
  settingsYaml: string
}

/** One agent in a workspace scan (agent.list / workspace.changed). */
export interface AgentSummary {
  slug: string
  name: string
  current: boolean
  sessions: SessionSummary[]
}

export interface SessionSummary {
  file: string
  startedAt: string // RFC3339
  modifiedAt: string // RFC3339
  sizeBytes: number
  preview?: string
  current: boolean
}

/** workspace.changed event payload. */
export interface WorkspaceChangedPayload {
  workspace: WorkspaceInfo
  agents: AgentSummary[]
  needsPick: boolean
}

export interface TokenPayload {
  messageId: string
  text: string // cumulative
}

export interface ThinkingPayload {
  messageId: string
  text: string // cumulative reasoning content
}

export interface ThinkingCompletedPayload {
  messageId: string
  durationMs: number
}

export interface WindowStatePayload {
  fullscreen: boolean
}

export type ApprovalDecision = 'allow' | 'dismiss'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cmdCounter = 0

export function makeCommand(name: string, payload?: unknown): Command {
  cmdCounter += 1
  return { type: 'command', id: `cmd_${Date.now()}_${cmdCounter}`, name, payload }
}
