/**
 * Agent-run event handlers: status, messages, tool calls, run lifecycle —
 * plus approval request/resolve, which mutate the tool-call list alongside.
 */
import { Ev } from './protocol'
import type { AgentStatus, ApprovalRequest, ChatMessage, ThinkingCompletedPayload, ToolCall } from './protocol'
import type { EventCtx, EventHandler } from './storeEvents'

/** Clear `streaming` without touching unchanged messages, so memoized chat
 *  blocks skip the settle pass. */
function settledMessages(ctx: EventCtx) {
  return ctx.state.agent.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
}

export const AGENT_EVENT_HANDLERS: Record<string, EventHandler> = {
  // agent.started carries no state of its own: status arrives via
  // agent.status.changed. Listed so the omission is deliberate.
  [Ev.AgentStarted]: () => {},

  [Ev.AgentStatusChanged]: (ctx, payload) => {
    const p = payload as { status?: AgentStatus } | undefined
    ctx.setAgent({ status: p?.status ?? 'idle' })
  },

  [Ev.AgentMessage]: (ctx, payload) => {
    const msg = payload as ChatMessage
    ctx.finalized.add(msg.id)
    const messages = [...ctx.state.agent.messages]
    const idx = messages.findIndex((m) => m.id === msg.id)
    if (idx >= 0) messages[idx] = msg
    else messages.push(msg)
    ctx.setAgent({ messages })
  },

  [Ev.AgentToolStarted]: (ctx, payload) => {
    const call = payload as ToolCall
    ctx.setAgent({ toolCalls: [...ctx.state.agent.toolCalls, call] })
  },

  [Ev.AgentToolCompleted]: (ctx, payload) => {
    const { toolCallId, status } = (payload ?? {}) as { toolCallId?: string; status?: ToolCall['status'] }
    if (!toolCallId || !status) return
    ctx.setAgent({
      toolCalls: ctx.state.agent.toolCalls.map((c) => (c.id === toolCallId ? { ...c, status } : c)),
    })
  },

  [Ev.AgentThinkingCompleted]: (ctx, payload) => {
    const tp = payload as ThinkingCompletedPayload
    const messages = [...ctx.state.agent.messages]
    const idx = messages.findIndex((m) => m.id === tp.messageId)
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], thinkingDone: true, thinkingMs: tp.durationMs }
    }
    ctx.setAgent({ messages })
  },

  // Finalize anything still streaming: a RAF-buffered token stream may have
  // set streaming:true just before this landed.
  [Ev.AgentCompleted]: (ctx) => {
    ctx.setAgent({ status: 'idle', messages: settledMessages(ctx) })
  },

  [Ev.AgentFailed]: (ctx, payload) => {
    ctx.setAgent({ status: 'error', messages: settledMessages(ctx) })
    ctx.pushNotification('error', (payload as { message?: string })?.message ?? 'agent failed')
  },

  [Ev.SidecarLost]: (ctx, payload) => {
    ctx.pushNotification('error', (payload as { message?: string })?.message ?? 'agent sidecar lost')
  },
}

/** Pair an approval with the tool call that requested it. */
function findPendingToolCall(ctx: EventCtx, req: ApprovalRequest): string | undefined {
  // Exact match first: the backend stamps the originating toolCallId.
  if (req.toolCallId) {
    const exact = ctx.state.agent.toolCalls.find((c) => c.id === req.toolCallId)
    if (exact) return exact.id
  }
  // Fallback for legacy events: the most recent running call of the matching
  // kind. WRONG for parallel same-kind calls (it reverses the pairing) — only a
  // best effort when toolCallId is absent.
  const want = req.kind === 'bash' ? 'run' : 'propose_edit'
  for (let i = ctx.state.agent.toolCalls.length - 1; i >= 0; i--) {
    const c = ctx.state.agent.toolCalls[i]
    if (c.tool === want && c.status === 'running') return c.id
  }
  return undefined
}

export const APPROVAL_EVENT_HANDLERS: Record<string, EventHandler> = {
  [Ev.ApprovalRequested]: (ctx, payload) => {
    const req = payload as ApprovalRequest
    const pending = findPendingToolCall(ctx, req)
    const toolCalls = ctx.state.agent.toolCalls.map((c) =>
      c.id === pending
        ? { ...c, status: 'pending_approval' as const, approvalId: req.id, what: req.what }
        : c,
    )
    const pendingApprovals = [...ctx.state.pendingApprovals, req]
    // Auto-focus the new approval unless the current focus is still a live
    // pending approval (a dangling id must not block focus).
    const cur = ctx.state.focusedApprovalId
    const keepFocus = cur !== null && pendingApprovals.some((a) => a.id === cur)
    ctx.set({
      pendingApprovals,
      focusedApprovalId: keepFocus ? cur : req.id,
      focusedToolCallId: null,
      contentPinned: false, // a new approval is an attention magnet
      agent: { ...ctx.state.agent, status: 'awaiting_tool_approval', toolCalls },
    })
    ctx.syncClocks()
  },

  [Ev.ApprovalResolved]: (ctx, payload) => {
    const { approvalId } = (payload ?? {}) as { approvalId?: string }
    const pendingApprovals = ctx.state.pendingApprovals.filter((a) => a.id !== approvalId)
    ctx.set({
      pendingApprovals,
      focusedApprovalId:
        ctx.state.focusedApprovalId === approvalId
          ? (pendingApprovals[0]?.id ?? null)
          : ctx.state.focusedApprovalId,
      focusedToolCallId: null,
      agent: { ...ctx.state.agent, status: 'reasoning' },
    })
    ctx.syncClocks()
  },
}
