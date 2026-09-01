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
} as const

export const Stream = {
  AgentToken: 'agent.token',
  ToolOutput: 'agent.tool.output',
} as const

// ---------------------------------------------------------------------------
// Domain view models
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'thinking' | 'streaming' | 'awaiting_approval' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

export type ToolCallStatus = 'running' | 'done' | 'error' | 'pending_approval'

export interface ToolCall {
  id: string
  tool: string
  label: string
  path?: string
  status: ToolCallStatus
  approvalId?: string
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

/** settings.get response / settings.save request+response payload. */
export interface SettingsYAML {
  yaml: string
}

export interface AgentState {
  status: AgentStatus
  messages: ChatMessage[]
  toolCalls: ToolCall[]
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
