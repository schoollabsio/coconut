/**
 * approvalClock — how one approval's clock reads, as pure functions so the
 * wording and the bar are testable without rendering. The countdown text and
 * the elapsed bar are derived from the same numbers the timer uses, so the card
 * can never advertise more time than it will actually give you.
 */
import { budgetMs, remainingMs, secondsLabel, type Budgetable, type Deadline } from './autoApprove'

export const CLOCK_SPENT_LABEL = 'timer cancelled · waiting for your decision'
/** Arming is forward-only, so an approval that predates the switch has no clock
 *  and never will — the line says so, or "why didn't THAT one auto-approve?"
 *  becomes the mystery. */
export const CLOCK_MANUAL_LABEL = 'no timer · it was already waiting'

export type ClockView =
  /** Nothing to show: the mode is off, or this approval has no clock. */
  | { kind: 'idle' }
  /** Counting down. `percent` is the time REMAINING, so the bar drains. */
  | { kind: 'running'; label: string; percent: number }
  /** The user took the countdown back (or it already fired): manual only. */
  | { kind: 'spent'; label: string }
  /** Never armed, because it was already waiting when the mode came on. */
  | { kind: 'manual'; label: string }

/** The card line for a clock. `on` is the per-window switch, not a clock
 *  property: with the mode off there is no countdown to advertise even if a
 *  stale deadline is still in the map. */
export function clockView(
  approval: Budgetable,
  deadline: Deadline | undefined,
  on: boolean,
  now: number,
): ClockView {
  if (!on || !deadline) return { kind: 'idle' }
  if (deadline.mode === 'cancelled') return { kind: 'spent', label: CLOCK_SPENT_LABEL }
  if (deadline.mode === 'manual') return { kind: 'manual', label: CLOCK_MANUAL_LABEL }

  const left = remainingMs(deadline, now)
  if (left === 0) return { kind: 'running', label: 'auto-approving…', percent: 0 }
  const total = budgetMs(approval)
  const percent = Math.max(0, Math.min(100, Math.round((left / total) * 100)))
  return { kind: 'running', label: `auto-approves in ${secondsLabel(left)}`, percent }
}

/** How many approvals are counting down right now. "On" alone does not say
 *  whether anything is actually armed, so the header chip shows this number. */
export function runningCount(deadlines: Record<string, Deadline>): number {
  return Object.values(deadlines).filter((deadline) => deadline.mode === 'running').length
}

// ---------------------------------------------------------------- ticker ----

type TickListener = () => void

const tickListeners = new Set<TickListener>()
let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * The countdown's "now", in whole seconds. Quantised because a snapshot that
 * changes between two calls in one render pass would make React re-render in a
 * loop; once a second it changes for real, and that is the tick.
 */
export function clockSnapshot(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Re-render on the second. Shared by every visible countdown so ten pending
 * approvals cost one interval, which stops when the last countdown unmounts.
 */
export function subscribeClock(listener: TickListener): () => void {
  tickListeners.add(listener)
  tickTimer ??= setInterval(() => {
    for (const listener of [...tickListeners]) listener()
  }, 1_000)
  return () => {
    tickListeners.delete(listener)
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }
}
