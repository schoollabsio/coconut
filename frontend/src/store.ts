/**
 * UIStore — the single client-side state store (PLAN.md §7.3).
 *
 * The store derives UI state from backend events/snapshots; it does not
 * own domain truth. Framework-free with a React binding via
 * useSyncExternalStore.
 */

import { useSyncExternalStore } from 'react'
import type {
  AgentSummary,
  AuthLoginStartPayload,
  AuthModel,
  AuthStatusResult,
  BackendEvent,
  BackendMessage,
  SnapshotMessage,
  StreamMessage,
} from './protocol'
import type { EventCtx } from './storeEvents'
import { EVENT_HANDLERS } from './storeEvents'
import type { Notification, UIState } from './storeState'
import { initialState } from './storeState'
import { snapshotPatch } from './storeSnapshot'
import { applyStreamPayload } from './storeStreams'

// The state shape lives in storeState.ts; re-exported so existing call sites
// keep importing these types from './store'.
export type { AuthLoginFlow, AuthState, Notification, UIState } from './storeState'

type Listener = () => void

/**
 * The UI store. The members the handler/stream modules need (`state`, `set`,
 * `setAgent`, `finalized`) are public only because those modules live outside
 * the class — treat them as store-internal rather than part of its API.
 */
export class UIStore implements EventCtx {
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
  finalized = new Set<string>()

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

  set(patch: Partial<UIState>) {
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
  /** Update an agent's hasSystemPrompt badge locally after a save/clear. */
  setAgentHasPrompt(slug: string, has: boolean) {
    this.set({
      agentList: this.state.agentList.map((a) => (a.slug === slug ? { ...a, hasSystemPrompt: has } : a)),
    })
  }
  setSettingsOpen(open: boolean) {
    this.set({ settingsOpen: open })
  }
  focusApproval(id: string | null) {
    this.set({ focusedApprovalId: id, focusedToolCallId: null, contentPinned: false })
  }

  focusToolCall(id: string | null) {
    this.set({ focusedToolCallId: id, focusedApprovalId: null, contentPinned: false })
  }

  /** Pin the panel to a content-library entry (user-driven). The entry's
   *  document arrives via content.updated after the content.select command. */
  pinContent() {
    this.set({ contentPinned: true, focusedApprovalId: null, focusedToolCallId: null })
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
    // A snapshot is authoritative: drop buffered streams and the finalized-id
    // set (message ids may have been rebuilt) before adopting it wholesale.
    this.streamBuffer.clear()
    this.finalized.clear()
    if (snap.windowName) this.windowName = snap.windowName
    this.set(snapshotPatch(this.state, snap))
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
    // Domain mutation lives in the storeEvents tables (agent / approval /
    // content / session / auth); this stays a dispatch, not a 200-case switch.
    EVENT_HANDLERS[ev.name]?.(this, ev.payload)
    this.notify()
  }

  setAgent(patch: Partial<UIState['agent']>) {
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
      for (const [name, payload] of pending) applyStreamPayload(this, name, payload)
      this.notify()
    })
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
