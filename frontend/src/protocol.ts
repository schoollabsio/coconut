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
  AgentPromptGet: 'agent.prompt.get',
  AgentPromptSet: 'agent.prompt.set',
  WorkspacePick: 'workspace.pick',
  WorkspaceSet: 'workspace.set',
  AgentStart: 'agent.start',
  AgentCancel: 'agent.cancel',
  ApprovalRespond: 'agent.approval.respond',
  ContentSelect: 'content.select',
  SettingsGet: 'settings.get',
  SettingsSave: 'settings.save',
  SettingsValidate: 'settings.validate',
  WindowNew: 'window.new',
  Diagnostics: 'diagnostics.log',

  // Auth (provider credentials via the coconut-login helper)
  AuthStatus: 'auth.status',
  AuthLogin: 'auth.login',
  AuthLoginPrompt: 'auth.login.prompt',
  AuthLoginCancel: 'auth.login.cancel',
  AuthLogout: 'auth.logout',
  AuthSetApiKey: 'auth.set_api_key',
  AuthModels: 'auth.models',
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
  ContentLibraryChanged: 'content.library.changed',
  WindowStateChanged: 'window.state.changed',
  SettingsChanged: 'settings.changed',
  Notification: 'notification.created',
  AgentThinkingCompleted: 'agent.thinking.completed',
  AgentPromptChanged: 'agent.prompt.changed',

  // Auth login flow (all carry a loginId)
  AuthLoginStarted: 'auth.login.started',
  AuthLoginStep: 'auth.login.step',
  AuthLoginPrompt: 'auth.login.prompt',
  AuthLoginCompleted: 'auth.login.completed',
  AuthLoginCancelled: 'auth.login.cancelled',
  AuthLoginFailed: 'auth.login.failed',
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
  seq?: number
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
  seq?: number
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
  /** Originating tool call — exact match for the call that requested this approval. */
  toolCallId?: string
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
  /** Project file a file-mode entry was snapshotted from (empty for composed docs). */
  sourcePath?: string
}

/** One persisted document in an agent's content library. */
export interface ContentEntry {
  name: string // file name within the content dir (= id)
  format: 'markdown' | 'html'
  sizeBytes: number
  updatedAt: number // unix ms; library sorts newest first
}

/** content.library.changed payload (wholesale replace). */
export interface ContentLibraryPayload {
  entries: ContentEntry[]
}

/** content.select payload. */
export interface ContentSelectPayload {
  name: string
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

// ---------------------------------------------------------------------------
// Auth (login helper) payloads
// ---------------------------------------------------------------------------

export type AuthType = 'oauth' | 'api_key'

export interface AuthLoginStartPayload {
  provider: string
  authType: AuthType
}

/** Answers a login prompt. Cancel=true dismisses the step. */
export interface AuthLoginPromptPayload {
  promptId: string
  value?: string
  cancel?: boolean
}

export interface AuthLoginCancelPayload {
  loginId: string
}

export interface AuthProviderPayload {
  provider: string
}

export interface AuthSetApiKeyPayload {
  provider: string
  key: string
}

export interface AuthModelsPayload {
  provider?: string
}

/** One provider in auth.status results. */
export interface AuthProviderStatus {
  id: string
  name: string
  oauth: boolean
  apiKey: boolean
  configured: boolean
  source?: string
  type?: 'oauth' | 'api_key'
}

export interface CredentialInfo {
  providerId: string
  type: 'oauth' | 'api_key'
}

export interface AuthStatusResult {
  providers: AuthProviderStatus[]
  credentials: CredentialInfo[]
  activeProvider?: string
  /** Raw settings.yaml model: value (may be provider-prefixed or :thinking-suffixed). */
  activeModel?: string
}

export interface AuthModel {
  id: string
  name: string
  provider: string
  contextWindow?: number
  reasoning?: boolean
}

// pi AuthEvent / AuthPrompt shapes (forwarded by the helper)
export interface AuthEvent {
  type: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  url?: string
  /** pi's device-code flows carry the sign-in page here (e.g. github.com/login/device). */
  verificationUri?: string
  userCode?: string
  verifier?: string
  interval?: number
  expiresInSeconds?: number
}

export interface AuthPrompt {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  /** The question (pi uses `message`; `label` kept as fallback). */
  message?: string
  label?: string
  placeholder?: string
  options?: { id: string; label: string }[]
}

export interface AuthLoginStepPayload {
  loginId: string
  event: AuthEvent
}

export interface AuthLoginPromptEvent {
  loginId: string
  promptId: string
  prompt: AuthPrompt
}

export interface AuthLoginDonePayload {
  loginId: string
  provider: string
}

export interface AuthLoginErrorPayload {
  loginId: string
  message: string
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
  contentLibrary?: ContentEntry[]
  pendingApprovals: ApprovalRequest[]
  settingsYaml: string
}

/** One agent in a workspace scan (agent.list / workspace.changed). */
export interface AgentSummary {
  slug: string
  name: string
  current: boolean
  sessions: SessionSummary[]
  /** Agent has a custom system-prompt.md on disk (picker badge). */
  hasSystemPrompt?: boolean
}

/** agent.prompt.get payload. */
export interface AgentPromptGetPayload {
  slug: string
}

/** agent.prompt.set payload; an empty prompt clears the file. */
export interface AgentPromptSetPayload {
  slug: string
  prompt: string
}

/** agent.prompt.get / agent.prompt.set result. */
export interface AgentPromptResult {
  slug: string
  prompt: string
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
