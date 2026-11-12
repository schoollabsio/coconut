/**
 * Content-panel / session-lifecycle event handlers: what the panel shows,
 * workspace + session switches, and the local notification channel.
 */
import { Ev } from './protocol'
import type { ContentDoc, ContentLibraryPayload, SettingsYAML, WindowStatePayload, WorkspaceChangedPayload } from './protocol'
import type { Notification } from './storeState'
import type { EventHandler } from './storeEvents'

export const CONTENT_EVENT_HANDLERS: Record<string, EventHandler> = {
  [Ev.ContentUpdated]: (ctx, payload) => {
    const doc = (payload as ContentDoc | null) ?? null
    // Fresh agent output shows itself unless an approval is pending (the
    // panel's pending chip signals it instead). A null doc (agent reset)
    // drops the pin.
    let contentPinned = ctx.state.contentPinned
    if (doc == null) contentPinned = false
    else if (ctx.state.pendingApprovals.length === 0) contentPinned = true
    ctx.set({ content: doc, focusedToolCallId: null, contentPinned })
  },

  [Ev.ContentLibraryChanged]: (ctx, payload) => {
    const lp = payload as ContentLibraryPayload | undefined
    ctx.set({ contentLibrary: lp?.entries ?? [] })
  },

  [Ev.SettingsChanged]: (ctx, payload) => {
    ctx.set({ settingsYaml: (payload as SettingsYAML).yaml })
  },

  [Ev.WindowStateChanged]: (ctx, payload) => {
    ctx.set({ isFullscreen: (payload as WindowStatePayload).fullscreen })
  },

  [Ev.Notification]: (ctx, payload) => {
    const p = payload as { level?: Notification['level']; message?: string } | undefined
    ctx.pushNotification(p?.level ?? 'info', String(p?.message ?? ''))
  },
}

export const SESSION_EVENT_HANDLERS: Record<string, EventHandler> = {
  [Ev.WorkspaceChanged]: (ctx, payload) => {
    const wc = payload as WorkspaceChangedPayload
    ctx.set({ workspace: wc.workspace, needsWorkspace: false, agentPickerOpen: false })
    // Agents already exist: the picker doubles as the "pick one" prompt.
    if (wc.needsPick && wc.agents?.length) ctx.set({ agentPickerOpen: true, agentList: wc.agents })
  },

  [Ev.SessionRestored]: (ctx, payload) => {
    const p = payload as { agentName?: string; agentSlug?: string } | undefined
    ctx.set({
      agentName: p?.agentName || ctx.state.agentName,
      agentSlug: p?.agentSlug || ctx.state.agentSlug,
      needsWorkspace: false,
      agentPickerOpen: false,
    })
    // The backend rebuilt its message history (workspace/agent switch,
    // restore, crash restart) — pull the authoritative snapshot.
    ctx.resync?.()
  },

  [Ev.AgentReset]: (ctx) => {
    ctx.finalized.clear()
    ctx.set({
      agent: { status: 'idle', messages: [], toolCalls: [] },
      pendingApprovals: [],
      focusedApprovalId: null,
      focusedToolCallId: null,
      contentPinned: false,
      content: null,
      // contentLibrary survives: it is per-agent, not per-session.
      expandedGroups: new Set<string>(),
    })
  },
}
