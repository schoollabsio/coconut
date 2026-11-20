/**
 * storeClocks — the wall-clock timers behind auto-approve.
 *
 * autoApprove.ts owns the arithmetic (pure, no timers); UIStore owns the
 * pending set; this module is the seam between them: it schedules one timeout
 * per running deadline and, when one expires, sends the ordinary approval
 * response. It lives outside store.ts so the timing rules and their races sit
 * in one place that can be tested with a fake context and fake timers.
 */
import { armPlan, cancel as spentClock, markUntimed, type Deadline } from './autoApprove'
import type { ApprovalDecision } from './approvalActions'
import type { Notification, UIState } from './storeState'

/** The slice of the store the clock owner may touch. */
export interface ClockCtx {
  state: UIState
  set(patch: Partial<UIState>): void
  pushNotification(level: Notification['level'], message: string): void
  /** Transport for one decision, injected by the bootstrapper (App.tsx). */
  respondApproval: ((approvalId: string, decision: ApprovalDecision) => Promise<boolean>) | null
}

/** Scheduled clocks by approval id: the handle plus the instant it was armed
 *  for, so an unchanged deadline is never restarted and a moved one never keeps
 *  a stale handle. */
export type ClockTimers = Map<string, { handle: ReturnType<typeof setTimeout>; expiresAt: number }>

/** Re-derive the clocks from the current pending set: a newly pending approval
 *  gets a clock, an existing one keeps whatever it had (running, cancelled or
 *  untimed), a resolved one is dropped. With the mode off there are no clocks.
 */
export function syncClocks(ctx: ClockCtx, timers: ClockTimers): void {
  const { on, deadlines } = ctx.state.autoApprove
  const next = on ? armPlan(ctx.state.pendingApprovals, deadlines, Date.now()) : {}
  ctx.set({ autoApprove: { on, deadlines: next } })
  schedule(ctx, timers, next)
}

/** The header switch flipping ON — forward-only. Every approval ALREADY waiting
 *  is marked untimed rather than armed: a switch nobody was watching must not
 *  start a countdown under a request that did not have one, so only approvals
 *  that arrive from here on are ever armed. */
export function enableClocks(ctx: ClockCtx, timers: ClockTimers): void {
  const deadlines = markUntimed(ctx.state.pendingApprovals, ctx.state.autoApprove.deadlines)
  ctx.set({ autoApprove: { on: true, deadlines } })
  schedule(ctx, timers, deadlines)
}

/** The header switch flipping OFF: every clock dies immediately, marks
 *  included. Switching back on marks the whole pending set untimed again, so an
 *  approval can never come back armed from an off/on round trip. */
export function disableClocks(ctx: ClockCtx, timers: ClockTimers): void {
  ctx.set({ autoApprove: { on: false, deadlines: {} } })
  schedule(ctx, timers, {})
}

/** Take one clock out of the timer's hands for good: the card's "cancel timer",
 *  and also what firing does, so one deadline yields at most one auto-approval
 *  however the response comes back. */
export function spendClock(ctx: ClockCtx, timers: ClockTimers, approvalId: string): void {
  const deadlines = { ...ctx.state.autoApprove.deadlines, [approvalId]: spentClock() }
  ctx.set({ autoApprove: { ...ctx.state.autoApprove, deadlines } })
  schedule(ctx, timers, deadlines)
}

/** A clock expired. Two races to lose quietly: the approval may already be
 *  resolved (a click, another window, the backend), and the switch may have been
 *  flipped off in the meantime. */
export function fireClock(ctx: ClockCtx, timers: ClockTimers, approvalId: string): void {
  spendClock(ctx, timers, approvalId)
  if (!ctx.state.autoApprove.on) return
  if (!ctx.state.pendingApprovals.some((a) => a.id === approvalId)) return
  if (!ctx.respondApproval) {
    ctx.pushNotification('error', 'Auto-approve could not send: no backend connection')
    return
  }
  void ctx.respondApproval(approvalId, 'allow').then((ok) => {
    if (!ok) ctx.pushNotification('warning', 'An auto-approval no longer applied (already resolved elsewhere?)')
  })
}

function schedule(ctx: ClockCtx, timers: ClockTimers, deadlines: Record<string, Deadline>) {
  const now = Date.now()
  for (const [id, timer] of timers) {
    const live = deadlines[id]
    if (live?.mode === 'running' && live.expiresAt === timer.expiresAt) continue
    clearTimeout(timer.handle)
    timers.delete(id)
  }
  for (const [id, deadline] of Object.entries(deadlines)) {
    if (deadline.mode !== 'running' || timers.has(id)) continue
    const handle = setTimeout(() => fireClock(ctx, timers, id), Math.max(0, deadline.expiresAt - now))
    timers.set(id, { handle, expiresAt: deadline.expiresAt })
  }
}
