/**
 * The store's state shape (PLAN.md §7.3): types + initial value, no behavior.
 * store.ts re-exports these so existing call sites keep importing them from
 * './store'; the handler/helper modules import them from here.
 */
import type {
  AgentStatus,
  ApprovalRequest,
  AgentSummary,
  AuthEvent,
  AuthModel,
  AuthPrompt,
  AuthStatusResult,
  ChatMessage,
  ContentDoc,
  ContentEntry,
  ToolCall,
  WorkspaceInfo,
} from './protocol'

export interface Notification {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
}

/** One in-flight login flow (auth.login.* events). */
export interface AuthLoginFlow {
  loginId: string
  provider: string
  /** notify events in arrival order (info / auth_url / device_code / progress). */
  steps: AuthEvent[]
  /** The prompt currently awaiting an answer, if any. */
  prompt: { promptId: string; prompt: AuthPrompt } | null
  /** Terminal state once reached; null while in flight. */
  result: 'completed' | 'cancelled' | 'failed' | null
  message?: string
}

export interface AuthState {
  /** auth.status result (providers + credential status). */
  status: AuthStatusResult | null
  /** auth.models result for `modelsFor`. */
  models: AuthModel[]
  modelsFor: string
  /** Active login flow (at most one). */
  login: AuthLoginFlow | null
}

export interface UIState {
  connected: boolean
  lastBackendSeq: number
  agentName: string
  agentSlug: string
  workspace: WorkspaceInfo | null
  needsWorkspace: boolean
  /** macOS fullscreen: traffic lights hidden, so the Header can drop its left padding. */
  isFullscreen: boolean
  agent: {
    status: AgentStatus
    messages: ChatMessage[]
    toolCalls: ToolCall[]
  }
  content: ContentDoc | null
  /** The agent's persisted content library (snapshot + content.library.changed), newest first. */
  contentLibrary: ContentEntry[]
  pendingApprovals: ApprovalRequest[]
  /** Approval currently focused in the content panel. */
  focusedApprovalId: string | null
  /** Tool call currently focused in the content panel. */
  focusedToolCallId: string | null
  /** User explicitly pinned the panel to a library entry: content beats the
   *  pending-approval fallback until focus moves or a new approval lands. */
  contentPinned: boolean
  /** Raw settings.yaml text; edited in the settings modal. */
  settingsYaml: string | null
  settingsOpen: boolean
  /** Agent/session picker modal. */
  agentPickerOpen: boolean
  agentList: AgentSummary[]
  /** Provider auth (settings → Provider panel). Driven by auth.* commands
   *  + auth.login.* events; not part of the backend snapshot. */
  auth: AuthState
  notifications: Notification[]
  /** Expanded group keys for the tool call log (UI-only, not synced to backend). Groups default to collapsed. */
  expandedGroups: Set<string>
}

export const initialState: UIState = {
  connected: false,
  lastBackendSeq: 0,
  agentName: 'Untitled Agent',
  agentSlug: '',
  workspace: null,
  needsWorkspace: false,
  isFullscreen: false,
  agent: { status: 'idle', messages: [], toolCalls: [] },
  content: null,
  contentLibrary: [],
  pendingApprovals: [],
  focusedApprovalId: null,
  focusedToolCallId: null,
  contentPinned: false,
  settingsYaml: null,
  settingsOpen: false,
  agentPickerOpen: false,
  agentList: [],
  auth: {
    status: null,
    models: [],
    modelsFor: '',
    login: null,
  },
  notifications: [],
  expandedGroups: new Set<string>(),
}
