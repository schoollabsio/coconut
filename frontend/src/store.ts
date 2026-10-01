/**
 * UIStore — the single client-side state store (PLAN.md §7.3).
 *
 * The store derives UI state from backend events/snapshots; it does not
 * own domain truth. Framework-free with a React binding via
 * useSyncExternalStore.
 */

import { useSyncExternalStore } from 'react'
import type {
  AgentStatus,
  ApprovalRequest,
  AgentSummary,
  AuthEvent,
  AuthLoginPromptEvent,
  AuthLoginStartPayload,
  AuthLoginStepPayload,
  AuthModel,
  AuthPrompt,
  AuthStatusResult,
  BackendEvent,
  BackendMessage,
  ChatMessage,
  ContentDoc,
  SettingsYAML,
  SnapshotMessage,
  StreamMessage,
  ThinkingCompletedPayload,
  ThinkingPayload,
  ToolCall,
  WindowStatePayload,
  WorkspaceChangedPayload,
  WorkspaceInfo,
} from './protocol'
import { Ev, Stream } from './protocol'

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
  pendingApprovals: ApprovalRequest[]
  /** Approval currently focused in the content panel. */
  focusedApprovalId: string | null
  /** Tool call currently focused in the content panel. */
  focusedToolCallId: string | null
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

const initialState: UIState = {
  connected: false,
  lastBackendSeq: 0,
  agentName: 'Untitled Agent',
  agentSlug: '',
  workspace: null,
  needsWorkspace: false,
  isFullscreen: false,
  agent: { status: 'idle', messages: [], toolCalls: [] },
  content: null,
  pendingApprovals: [],
  focusedApprovalId: null,
  focusedToolCallId: null,
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

type Listener = () => void

export class UIStore {
  state: UIState = initialState

  private listeners = new Set<Listener>()
  /** Stream payloads buffered until the next animation frame (§10.2). */
  private streamBuffer = new Map<string, unknown>()
  private rafScheduled = false
  private notifCounter = 0
  /** Message ids finalized via `agent.message.appended`. A token/thinking
   *  stream buffered in the rAF queue can flush *after* the finalization
   *  event (streams are unsequenced); it carries no new text and must not
   *  re-mark the message as streaming — that would swap StreamingText back
   *  in and re-fade the tail from opacity 0 (end-of-message flicker).
   *  The status guard alone doesn't cover this window (agent_settled may
   *  not have arrived yet). Cleared on snapshot/reset; ids are unique per
   *  run, so no collisions. */
  private finalized = new Set<string>()

  /** Filled in by the bootstrapper; used for seq-gap recovery. */
  resync: (() => void) | null = null

  /** This window's sender tag (from the snapshot). Envelopes sent to
   *  other windows are dropped — v3 broadcasts custom events app-wide. */
  windowName: string | null = null

  subscribe = (listener: Listener): Unsubscribe => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    for (const l of this.listeners) l()
  }

  getSnapshot = (): UIState => this.state

  private set(patch: Partial<UIState>) {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  // ------------------------------------------------------------------
  // local UI events (PLAN.md §6.3 style)
  // ------------------------------------------------------------------

  setAgentNameLocal(name: string) {
    this.set({ agentName: name })
  }
  setNeedsWorkspace(needs: boolean) {
    this.set({ needsWorkspace: needs })
  }
  openAgentPicker(agents: AgentSummary[]) {
    this.set({ agentPickerOpen: true, agentList: agents })
    this.notify()
  }
  closeAgentPicker() {
    this.set({ agentPickerOpen: false })
    this.notify()
  }
  setSettingsOpen(open: boolean) {
    this.set({ settingsOpen: open })
  }
  focusApproval(id: string | null) {
    this.set({ focusedApprovalId: id, focusedToolCallId: null })
  }

  focusToolCall(id: string | null) {
    this.set({ focusedToolCallId: id, focusedApprovalId: null })
  }

  // ------------------------------------------------------------------
  // auth (settings → Provider panel)
  // ------------------------------------------------------------------

  setAuthStatus(status: AuthStatusResult | null) {
    const a = this.state.auth
    // A new status snapshot supersedes any stale login flow for another
    // provider; an in-flight flow for the SAME provider stays live.
    const login = a.login && a.login.result === null ? a.login : null
    this.set({ auth: { status, models: a.models, modelsFor: a.modelsFor, login } })
  }

  setAuthModels(models: AuthModel[], provider: string) {
    this.set({ auth: { ...this.state.auth, models, modelsFor: provider } })
  }

  /** Begin tracking a login flow (from the auth.login response). */
  beginAuthLogin(payload: AuthLoginStartPayload & { loginId: string }) {
    this.set({
      auth: {
        ...this.state.auth,
        login: { loginId: payload.loginId, provider: payload.provider, steps: [], prompt: null, result: null },
      },
    })
  }

  /** Drop a finished flow (user closed the panel after the outcome). */
  clearAuthLogin() {
    this.set({ auth: { ...this.state.auth, login: null } })
  }
  dismissNotification(id: number) {
    this.set({ notifications: this.state.notifications.filter((n) => n.id !== id) })
  }

  // ------------------------------------------------------------------
  // tool call group expansion state (local UI state)
  // ------------------------------------------------------------------

  toggleGroup(key: string) {
    const next = new Set(this.state.expandedGroups)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this.set({ expandedGroups: next })
  }
  collapseGroup(key: string) {
    if (!this.state.expandedGroups.has(key)) return
    const next = new Set(this.state.expandedGroups)
    next.delete(key)
    this.set({ expandedGroups: next })
  }
  expandGroup(key: string) {
    if (this.state.expandedGroups.has(key)) return
    const next = new Set(this.state.expandedGroups)
    next.add(key)
    this.set({ expandedGroups: next })
  }

  // ------------------------------------------------------------------
  // backend messages
  // ------------------------------------------------------------------

  applyBackendMessage(msg: BackendMessage, sender?: string) {
    // Window-scoping: v3 delivers every 'backend' envelope to every
    // window. Once we know our own windowName (from the snapshot), drop
    // envelopes sent to a different window.
    if (msg.type !== 'snapshot' && sender && this.windowName && sender !== this.windowName) {
      return
    }
    switch (msg.type) {
      case 'event':
        this.applyEvent(msg)
        return
      case 'stream':
        this.bufferStream(msg)
        return
      case 'snapshot':
        this.applySnapshot(msg)
        return
      case 'error':
        this.pushNotification('error', `${msg.code}: ${msg.message}`)
        return
    }
  }

  private applySnapshot(snap: SnapshotMessage) {
    const s = snap.state
    this.streamBuffer.clear()
    this.finalized.clear()
    if (snap.windowName) this.windowName = snap.windowName
    const focusedApprovalId = s.pendingApprovals.some((a) => a.id === this.state.focusedApprovalId)
      ? this.state.focusedApprovalId
      : (s.pendingApprovals[0]?.id ?? null)
    this.set({
      connected: true,
      needsWorkspace: !(s.workspace?.path),
      lastBackendSeq: snap.seq,
      agentName: s.agentName || 'Untitled Agent',
      agentSlug: s.agentSlug || '',
      workspace: s.workspace?.path ? s.workspace : null,
      agent: {
        status: s.agent.status,
        messages: [...s.agent.messages],
        toolCalls: [...s.agent.toolCalls],
      },
      content: s.content,
      pendingApprovals: [...s.pendingApprovals],
      // Reconcile focus against the authoritative list: a stale focus id
      // (e.g. approval resolved while we were disconnected/resyncing)
      // would otherwise block auto-focus of new approvals forever.
      focusedApprovalId,
      focusedToolCallId: focusedApprovalId
        ? null
        : (s.agent.toolCalls.some((c) => c.id === this.state.focusedToolCallId)
            ? this.state.focusedToolCallId
            : null),
      settingsYaml: s.settingsYaml,
    })
  }

  private applyEvent(ev: BackendEvent) {
    // Seq-gap recovery (PLAN.md §8.4): a gap means we missed state;
    // resync via snapshot instead of applying out of order.
    if (ev.seq <= this.state.lastBackendSeq) return // duplicate/replay
    if (this.state.lastBackendSeq !== 0 && ev.seq !== this.state.lastBackendSeq + 1) {
      this.resync?.()
      return
    }
    this.state = { ...this.state, lastBackendSeq: ev.seq }

    const p = ev.payload as Record<string, any> | undefined
    switch (ev.name) {
      // AgentStarted handler - status is handled by EvAgentStatusChanged
      case Ev.AgentStarted:
        break
      case Ev.AgentStatusChanged:
        this.setAgent({ status: (p?.status ?? 'idle') as AgentStatus })
        break
      case Ev.AgentMessage: {
        const msg = p as unknown as ChatMessage
        this.finalized.add(msg.id)
        const messages = [...this.state.agent.messages]
        const idx = messages.findIndex((m) => m.id === msg.id)
        if (idx >= 0) messages[idx] = msg
        else messages.push(msg)
        this.setAgent({ messages })
        break
      }
      case Ev.AgentToolStarted: {
        const call = p as unknown as ToolCall
        this.setAgent({ toolCalls: [...this.state.agent.toolCalls, call] })
        break
      }
      case Ev.AgentToolCompleted: {
        const toolCalls = this.state.agent.toolCalls.map((c) =>
          c.id === p?.toolCallId ? { ...c, status: p.status as ToolCall['status'] } : c,
        )
        this.setAgent({ toolCalls })
        break
      }
      case Ev.ApprovalRequested: {
        const req = p as unknown as ApprovalRequest
        const toolCalls = this.state.agent.toolCalls.map((c) =>
          c.id === this.findPendingToolCall(req) ? { ...c, status: 'pending_approval' as const, approvalId: req.id, what: req.what } : c,
        )
        const pendingApprovals = [...this.state.pendingApprovals, req]
        // Auto-focus the new approval unless the current focus is still a
        // live pending approval (a dangling id must not block focus).
        const cur = this.state.focusedApprovalId
        const keepFocus = cur !== null && pendingApprovals.some((a) => a.id === cur)
        this.set({
          pendingApprovals,
          focusedApprovalId: keepFocus ? cur : req.id,
          focusedToolCallId: null,
          agent: { ...this.state.agent, status: 'awaiting_tool_approval', toolCalls },
        })
        break
      }
      case Ev.ApprovalResolved: {
        const pendingApprovals = this.state.pendingApprovals.filter((a) => a.id !== p?.approvalId)
        this.set({
          pendingApprovals,
          focusedApprovalId:
            this.state.focusedApprovalId === p?.approvalId
              ? (pendingApprovals[0]?.id ?? null)
              : this.state.focusedApprovalId,
          focusedToolCallId: null,
          agent: { ...this.state.agent, status: 'reasoning' },
        })
        break
      }
      case Ev.AgentThinkingCompleted: {
        const tp = p as unknown as ThinkingCompletedPayload
        const messages = [...this.state.agent.messages]
        const idx = messages.findIndex((m) => m.id === tp.messageId)
        if (idx >= 0) {
          messages[idx] = { ...messages[idx], thinkingDone: true, thinkingMs: tp.durationMs }
        }
        this.setAgent({ messages })
        break
      }
      case Ev.AgentCompleted:
        // Finalize any messages still marked streaming — a RAF-buffered
        // token stream may have set streaming:true just before we here.
        // Untouched messages keep their object identity so the memoized
        // chat blocks skip this settle pass.
        this.setAgent({
          status: 'idle',
          messages: this.state.agent.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        })
        break
      case Ev.AgentFailed:
        this.setAgent({
          status: 'error',
          messages: this.state.agent.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        })
        this.pushNotification('error', (p?.message as string) ?? 'agent failed')
        break
      case Ev.SidecarLost:
        this.pushNotification('error', (p?.message as string) ?? 'agent sidecar lost')
        break
      case Ev.ContentUpdated:
        this.set({ content: p as unknown as ContentDoc, focusedToolCallId: null })
        break
      case Ev.SettingsChanged:
        this.set({ settingsYaml: (p as unknown as SettingsYAML).yaml })
        break
      case Ev.AuthLoginStarted:
        this.beginAuthLogin(p as unknown as AuthLoginStartPayload & { loginId: string })
        break
      case Ev.AuthLoginStep: {
        const sp = p as unknown as AuthLoginStepPayload
        const flow = this.state.auth.login
        if (flow && flow.loginId === sp.loginId) {
          this.set({ auth: { ...this.state.auth, login: { ...flow, steps: [...flow.steps, sp.event] } } })
        }
        break
      }
      case Ev.AuthLoginPrompt: {
        const pp = p as unknown as AuthLoginPromptEvent
        const flow = this.state.auth.login
        if (flow && flow.loginId === pp.loginId) {
          this.set({ auth: { ...this.state.auth, login: { ...flow, prompt: { promptId: pp.promptId, prompt: pp.prompt } } } })
        }
        break
      }
      case Ev.AuthLoginCompleted: {
        const flow = this.state.auth.login
        if (flow && flow.loginId === p?.loginId) {
          this.set({ auth: { ...this.state.auth, login: { ...flow, prompt: null, result: 'completed' } } })
        }
        break
      }
      case Ev.AuthLoginCancelled: {
        const flow = this.state.auth.login
        if (flow && flow.loginId === p?.loginId) {
          this.set({ auth: { ...this.state.auth, login: { ...flow, prompt: null, result: 'cancelled', message: p?.message as string } } })
        }
        break
      }
      case Ev.AuthLoginFailed: {
        const flow = this.state.auth.login
        if (flow && flow.loginId === p?.loginId) {
          this.set({ auth: { ...this.state.auth, login: { ...flow, prompt: null, result: 'failed', message: p?.message as string } } })
        }
        break
      }
      case Ev.WorkspaceChanged: {
        const wc = p as unknown as WorkspaceChangedPayload
        this.set({ workspace: wc.workspace, needsWorkspace: false, agentPickerOpen: false })
        if (wc.needsPick && wc.agents?.length) {
          this.set({ agentPickerOpen: true, agentList: wc.agents })
        }
        break
      }
      case Ev.SessionRestored: {
        this.set({
          agentName: (p?.agentName as string) || this.state.agentName,
          agentSlug: (p?.agentSlug as string) || this.state.agentSlug,
          needsWorkspace: false,
          agentPickerOpen: false,
        })
        // The backend rebuilt its message history (workspace/agent switch,
        // restore, crash restart) — pull the authoritative snapshot.
        this.resync?.()
        break
      }
      case Ev.AgentReset:
        this.finalized.clear()
        this.set({
          agent: { status: 'idle', messages: [], toolCalls: [] },
          pendingApprovals: [],
          focusedApprovalId: null,
          focusedToolCallId: null,
          content: null,
          expandedGroups: new Set<string>(),
        })
        break
      case Ev.WindowStateChanged:
        this.set({ isFullscreen: (p as WindowStatePayload).fullscreen })
        break
      case Ev.Notification:
        this.pushNotification((p?.level as Notification['level']) ?? 'info', String(p?.message ?? ''))
        break
      default:
        break
    }
    this.notify()
  }

  private findPendingToolCall(req: ApprovalRequest): string | undefined {
    // Exact match first: the backend stamps the originating toolCallId.
    if (req.toolCallId) {
      const exact = this.state.agent.toolCalls.find((c) => c.id === req.toolCallId)
      if (exact) return exact.id
    }
    // Fallback for legacy events: the most recent running call of the
    // matching kind. WRONG for parallel same-kind calls (it reverses the
    // pairing) — only a best effort when toolCallId is absent.
    const want = req.kind === 'bash' ? 'run' : 'propose_edit'
    for (let i = this.state.agent.toolCalls.length - 1; i >= 0; i--) {
      const c = this.state.agent.toolCalls[i]
      if (c.tool === want && c.status === 'running') return c.id
    }
    return undefined
  }

  private setAgent(patch: Partial<UIState['agent']>) {
    this.state = { ...this.state, agent: { ...this.state.agent, ...patch } }
  }

  pushNotification(level: Notification['level'], message: string) {
    if (!message) return
    const n: Notification = { id: ++this.notifCounter, level, message }
    this.state = { ...this.state, notifications: [...this.state.notifications, n].slice(-5) }
  }

  // ------------------------------------------------------------------
  // stream buffering (§10.2: flush via requestAnimationFrame)
  // ------------------------------------------------------------------

  private bufferStream(msg: StreamMessage) {
    this.streamBuffer.set(msg.name, msg.payload)
    if (this.rafScheduled) return
    this.rafScheduled = true
    requestAnimationFrame(() => {
      this.rafScheduled = false
      const pending = [...this.streamBuffer.entries()]
      this.streamBuffer.clear()
      for (const [name, payload] of pending) this.applyStream(name, payload)
      this.notify()
    })
  }

  private applyStream(name: string, payload: unknown) {
    if (name === Stream.AgentThinking) {
      const { messageId, text } = payload as ThinkingPayload
      if (this.finalized.has(messageId)) return // late flush after finalization
      const messages = [...this.state.agent.messages]
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        // Preserve thinkingDone if the completed event already set it
        // (events apply synchronously; streams are RAF-buffered).
        messages[idx] = { ...messages[idx], thinking: text }
      } else {
        messages.push({ id: messageId, role: 'assistant', text: '', thinking: text, thinkingDone: false })
      }
      // Don't change agent status — reasoning is the "reasoning" phase of
      // the status, parallel to text streaming which flips to 'generating'.
      this.state = { ...this.state, agent: { ...this.state.agent, messages } }
      return
    }
    if (name !== Stream.AgentToken) return
    // A RAF-buffered token stream can flush *after* agent.completed fires
    // (streams are unsequenced; events are processed synchronously).  Guard
    // against re-activating a terminal state: don't reset status to
    // 'generating' or re-mark a finalized message as streaming.
    if (this.state.agent.status === 'idle' || this.state.agent.status === 'error') return
    const { messageId, text } = payload as { messageId: string; text: string }
    if (this.finalized.has(messageId)) return // late flush after finalization
    const messages = [...this.state.agent.messages]
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], text, streaming: true }
    } else {
      messages.push({ id: messageId, role: 'assistant', text, streaming: true })
    }
    this.state = { ...this.state, agent: { ...this.state.agent, status: 'generating', messages } }
  }
}

type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export const store = new UIStore()

export function useUIState<T>(selector: (s: UIState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}
