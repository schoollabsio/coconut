/**
 * autoApprove — pure policy for reading-time approval timeouts (no store /
 * React / backend deps so it is unit-testable in Node).
 *
 * The timer itself is owned by the store and fires the existing
 * agent.approval.respond command, so an auto-approval is byte-for-byte the
 * same decision a click produces. Everything here is pure arithmetic over
 * timestamps so the three risky rules — how long you get, that a cancelled
 * countdown stays cancelled, and that turning the mode on arms nothing that was
 * already waiting — are testable without a store round-trip.
 */

/** Policy constants. Hardcoded by design: the runtime off-switch lives in the
 *  window header, and only the on/off state is user-facing. */
export interface BudgetConstants {
  /** Prose reading rate used to price `what` + `why`. */
  wordsPerMinute: number
  /** Minimum window. Guards the terse-proposal case: a two-word `what`
   *  otherwise computes to well under a second of review time. */
  floorMs: number
  /** Maximum window, so a rambling `why` cannot stall an agent indefinitely. */
  ceilingMs: number
}

export const AUTO_APPROVE_DEFAULTS: BudgetConstants = {
  wordsPerMinute: 240,
  floorMs: 5_000,
  ceilingMs: 180_000,
}

/** A pending approval's clock. Only `running` ever fires:
 *    - `fired` is the timer's own terminal mark — the budget ran out and the
 *      decision went out. It is NOT the user's cancellation, so the card must
 *      never describe it as one;
 *    - `cancelled` is terminal — the user took the decision back, so the
 *      countdown never restarts for that approval;
 *    - `manual` never started — the approval was already waiting when the mode
 *      was switched on, and arming is forward-only (flipping a switch must not
 *      light a fuse under something that had no countdown a moment ago).
 *  Every terminal mode stays the user's to decide by hand, or to sweep with the
 *  next prompt.
 *
 *  `totalMs` is the budget the timer was ACTUALLY armed with, carried on the
 *  deadline. The countdown bar divides by this rather than re-running budgetMs
 *  at paint time, so the bar and the timeout it visualises cannot drift apart —
 *  not across policy constants, not across re-renders, not at all. */
export type Deadline =
  | { mode: 'running'; expiresAt: number; totalMs: number }
  | { mode: 'fired' }
  | { mode: 'cancelled' }
  | { mode: 'manual' }

/** The slice of an approval the policy needs. Structural, so ApprovalRequest
 *  satisfies it without an import cycle into protocol.ts. */
export interface Budgetable {
  id: string
  what?: string
  why?: string
}

/** Whitespace-delimited word count.
 *
 *  Deliberately naive: it counts neither the diff nor punctuation. CJK text
 *  has no spaces, so a whole CJK sentence counts as one word and collapses to
 *  the floor — which is the *minimum* window rather than zero, the safe
 *  direction for a budget that gates a write. */
export function countWords(text: string | undefined): number {
  if (!text) return 0
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Reading-time budget for one approval.
 *  Counts `what` + `why` only — the diff is not priced (a diff needs its own
 *  slower line-rate, which this design deliberately does not model). */
export function budgetMs(
  approval: Budgetable,
  c: BudgetConstants = AUTO_APPROVE_DEFAULTS,
): number {
  const words = countWords(approval.what) + countWords(approval.why)
  const ms = (words / c.wordsPerMinute) * 60_000
  return Math.min(c.ceilingMs, Math.max(c.floorMs, Math.round(ms)))
}

/** A fresh, full-budget clock starting now. */
export function arm(now: number, approval: Budgetable, c: BudgetConstants = AUTO_APPROVE_DEFAULTS): Deadline {
  const totalMs = budgetMs(approval, c)
  return { mode: 'running', expiresAt: now + totalMs, totalMs }
}

/** Stop the countdown for good — no resume, no banked remainder. */
export function cancel(): Deadline {
  return { mode: 'cancelled' }
}

/** A clock that never starts: this approval was already waiting when the mode
 *  was turned on, so nothing will ever fire it. */
export function untimed(): Deadline {
  return { mode: 'manual' }
}

/** The timer's own terminal mark: it fired, and the decision went out with it.
 *  Kept distinct from `cancelled` because "you took this countdown back" is a
 *  false story about a clock that simply ran out — and because, like
 *  `cancelled`, it is non-running, so the scheduled handle is dropped and one
 *  deadline can never fire twice. */
export function fired(): Deadline {
  return { mode: 'fired' }
}

/** True when the USER took this decision back out of the timer's hands — which
 *  is not the same as the timer having fired it (see `fired`). */
export function isCancelled(deadline: Deadline): boolean {
  return deadline.mode === 'cancelled'
}

/** Ms until expiry; 0 once due, fired, cancelled, or never armed — so callers
 *  render without clamping. */
export function remainingMs(deadline: Deadline, now: number): number {
  return deadline.mode === 'running' ? Math.max(0, deadline.expiresAt - now) : 0
}

export function isDue(deadline: Deadline, now: number): boolean {
  return deadline.mode === 'running' && deadline.expiresAt <= now
}

/** Which approvals may fire now, in the order they were requested.
 *  Terminal clocks — fired, cancelled, never-armed — are never returned. Used
 *  by the overdue sweep for deadlines whose timer never got its callback (a
 *  hidden window throttles timers; a suspended process sleeps through them). */
export function dueIds(
  deadlines: Record<string, Deadline>,
  now: number,
): string[] {
  return Object.keys(deadlines).filter((id) => isDue(deadlines[id], now))
}

/** Next clock map for the pending set, used whenever the pending set changes.
 *
 *  Rules, in priority order:
 *    - ids not pending anymore are dropped (resolved, dismissed, swept);
 *    - a clock that exists is kept exactly as it is — a running one so an
 *      unrelated event cannot extend a window already counting, and a
 *      cancelled or manual one because neither may ever restart;
 *    - only a NEWLY pending approval gets a fresh clock.
 *
 *  Nothing here re-arms: enabling the mode is `markUntimed`, not a re-plan, so
 *  no code path can hand an old approval a countdown it never had.
 */
export function armPlan(
  approvals: Budgetable[],
  prev: Record<string, Deadline>,
  now: number,
  opts: { constants?: BudgetConstants } = {},
): Record<string, Deadline> {
  const c = opts.constants ?? AUTO_APPROVE_DEFAULTS
  const next: Record<string, Deadline> = {}
  for (const approval of approvals) {
    next[approval.id] = prev[approval.id] ?? arm(now, approval, c)
  }
  return next
}

/**
 * What the header switch does when it flips ON: every approval ALREADY waiting
 * becomes untimed, so the mode applies only to requests that arrive from here
 * on. An approval that has sat untouched for twenty minutes must not gain a
 * five-second fuse from a switch nobody was watching, and an approval whose
 * clock the user cancelled stays cancelled rather than being re-labelled.
 *
 * Clocks for approvals that are no longer pending are dropped, so the map
 * cannot grow without bound.
 */
export function markUntimed(approvals: Budgetable[], prev: Record<string, Deadline>): Record<string, Deadline> {
  const next: Record<string, Deadline> = {}
  for (const approval of approvals) {
    next[approval.id] = prev[approval.id] ?? untimed()
  }
  return next
}

/** Seconds label for the card countdown and the header chip:
 *  5000 -> "5s", 75000 -> "1m 15s", 180000 -> "3m". */
export function secondsLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}
