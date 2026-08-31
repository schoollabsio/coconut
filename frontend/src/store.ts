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
  BackendEvent,
  BackendMessage,
  ChatMessage,
  ContentDoc,
  SettingsYAML,
  SnapshotMessage,
  StreamMessage,
  ToolCall,
  WorkspaceChangedPayload,
  WorkspaceInfo,
} from './protocol'
import { Ev, Stream } from './protocol'

export interface Notification {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface UIState {
  connected: boolean
  lastBackendSeq: number
  agentName: string
  agentSlug: string
  workspace: WorkspaceInfo | null
  needsWorkspace: boolean
  agent: {
    status: AgentStatus
    messages: ChatMessage[]
    toolCalls: ToolCall[]
  }
  content: ContentDoc | null
  pendingApprovals: ApprovalRequest[]
  /** Approval currently focused in the content panel (click in tool log). */
  focusedApprovalId: string | null
  /** Raw settings.yaml text; edited in the settings modal. */
  settingsYaml: string | null
  settingsOpen: boolean
  /** Agent/session picker modal. */
  agentPickerOpen: boolean
  agentList: AgentSummary[]
  notifications: Notification[]
}

const initialState: UIState = {
  connected: false,
  lastBackendSeq: 0,
  agentName: 'Untitled Agent',
  agentSlug: '',
  workspace: null,
  needsWorkspace: false,
  agent: { status: 'idle', messages: [], toolCalls: [] },
  content: null,
  pendingApprovals: [],
  focusedApprovalId: null,
  settingsYaml: null,
  settingsOpen: false,
  agentPickerOpen: false,
  agentList: [],
  notifications: [],
}

type Listener = () => void

export class UIStore {
  state: UIState = initialState

  private listeners = new Set<Listener>()
  /** Stream payloads buffered until the next animation frame (§10.2). */
  private streamBuffer = new Map<string, unknown>()
  private rafScheduled = false
  private notifCounter = 0

  /** Filled in by the bootstrapper; used for seq-gap recovery. */
  resync: (() => void) | null = null

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
    this.set({ focusedApprovalId: id })
  }
  dismissNotification(id: number) {
    this.set({ notifications: this.state.notifications.filter((n) => n.id !== id) })
  }

  // ------------------------------------------------------------------
  // backend messages
  // ------------------------------------------------------------------

  applyBackendMessage(msg: BackendMessage) {
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
      case Ev.AgentStarted:
        this.setAgent({ status: 'thinking' })
        break
      case Ev.AgentStatusChanged:
        this.setAgent({ status: (p?.status ?? 'idle') as AgentStatus })
        break
      case Ev.AgentMessage: {
        const msg = p as unknown as ChatMessage
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
          c.id === this.findPendingToolCall(req) ? { ...c, status: 'pending_approval' as const, approvalId: req.id } : c,
        )
        this.set({
          pendingApprovals: [...this.state.pendingApprovals, req],
          focusedApprovalId: this.state.focusedApprovalId ?? req.id,
          agent: { ...this.state.agent, status: 'awaiting_approval', toolCalls },
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
          agent: { ...this.state.agent, status: 'thinking' },
        })
        break
      }
      case Ev.AgentCompleted:
        this.setAgent({ status: 'idle' })
        break
      case Ev.AgentFailed:
        this.setAgent({ status: 'error' })
        this.pushNotification('error', (p?.message as string) ?? 'agent failed')
        break
      case Ev.SidecarLost:
        this.pushNotification('error', (p?.message as string) ?? 'agent sidecar lost')
        break
      case Ev.ContentUpdated:
        this.set({ content: p as unknown as ContentDoc })
        break
      case Ev.SettingsChanged:
        this.set({ settingsYaml: (p as unknown as SettingsYAML).yaml })
        break
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
        this.set({
          agent: { status: 'idle', messages: [], toolCalls: [] },
          pendingApprovals: [],
          focusedApprovalId: null,
          content: null,
        })
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
    // The tool call that requested this approval is the most recent
    // running call of the matching kind.
    const want = req.kind === 'bash' ? 'bash' : 'propose_edit'
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
    if (name !== Stream.AgentToken) return
    const { messageId, text } = payload as { messageId: string; text: string }
    const messages = [...this.state.agent.messages]
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], text, streaming: true }
    } else {
      messages.push({ id: messageId, role: 'assistant', text, streaming: true })
    }
    this.state = { ...this.state, agent: { ...this.state.agent, status: 'streaming', messages } }
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
