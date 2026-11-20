/**
 * approvalClock — how one approval's clock reads, as pure functions so the
 * wording and the bar are testable without rendering. Both come out of the
 * deadline itself — the same number the timer was scheduled from — so the card
 * can never advertise more time than it will actually give you.
 */
import { remainingMs, secondsLabel, type Deadline } from './autoApprove'

export const CLOCK_SPENT_LABEL = 'timer cancelled · waiting for your decision'
/** The budget ran out and the decision went out with it. Deliberately not the
 *  `cancelled` wording: that one tells the user they took the decision back,
 *  and here the timer took it. */
export const CLOCK_FIRED_LABEL = 'auto-approved'
/** Arming is forward-only, so an approval that predates the switch has no clock
 *  and never will — the line says so, or "why didn't THAT one auto-approve?"
 *  becomes the mystery. */
export const CLOCK_MANUAL_LABEL = 'no timer · it was already waiting'

export type ClockView =
  /** Nothing to show: the mode is off, or this approval has no clock. */
  | { kind: 'idle' }
  /** Counting down. `percent` is the time REMAINING, so the bar drains. It is
   *  the static fallback: the live drain is the CSS animation sized on
   *  `totalMs`, which lands on zero at exactly `expiresAt`. */
  | { kind: 'running'; label: string; percent: number; totalMs: number; leftMs: number }
  /** The clock ran out and fired; nothing left to count. */
  | { kind: 'fired'; label: string }
  /** The user took the countdown back, for good. */
  | { kind: 'spent'; label: string }
  /** Never armed, because it was already waiting when the mode came on. */
  | { kind: 'manual'; label: string }

/** The card line for a clock. `on` is the per-window switch, not a clock
 *  property: with the mode off there is no countdown to advertise even if a
 *  stale deadline is still in the map.
 *
 *  Note what is deliberately NOT a parameter: the approval's `what`/`why`. The
 *  denominator is `deadline.totalMs` — the budget the timer was armed with — so
 *  the bar can be sized off the very window the timer will honour. */
export function clockView(deadline: Deadline | undefined, on: boolean, now: number): ClockView {
  if (!on || !deadline) return { kind: 'idle' }
  if (deadline.mode === 'fired') return { kind: 'fired', label: CLOCK_FIRED_LABEL }
  if (deadline.mode === 'cancelled') return { kind: 'spent', label: CLOCK_SPENT_LABEL }
  if (deadline.mode === 'manual') return { kind: 'manual', label: CLOCK_MANUAL_LABEL }

  const left = remainingMs(deadline, now)
  const totalMs = deadline.totalMs
  // The gap between this and `fired` is the window between the expiry the maths
  // can see and the moment the store's timer actually lands.
  if (left === 0) return { kind: 'running', label: 'auto-approving…', percent: 0, totalMs, leftMs: 0 }
  const percent = Math.max(0, Math.min(100, Math.round((left / totalMs) * 100)))
  return { kind: 'running', label: `auto-approves in ${secondsLabel(left)}`, percent, totalMs, leftMs: left }
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

/** The countdown's "now", in RAW milliseconds, refreshed only by the ticker.
 *
 *  useSyncExternalStore needs a getSnapshot that is stable until a change is
 *  announced, so the wall clock is read here on tick rather than in render. It
 *  is deliberately NOT quantised to whole seconds: flooring biased every painted
 *  countdown up to a full second ahead of the time actually left, so a card
 *  still read "1s" with a 10-20% bar at the instant the timer fired. */
let currentNow = Date.now()

export function clockSnapshot(): number {
  return currentNow
}

/** Re-read the wall clock and re-render every countdown. The interval calls this
 *  once a second; App.tsx also calls it when the window comes back, where the
 *  interval may have been throttled (or slept clean through) while hidden. */
export function refreshClock(): void {
  currentNow = Date.now()
  for (const listener of [...tickListeners]) listener()
}

/** Re-render on the second. Shared by every visible countdown so ten pending
 *  approvals cost one interval, which stops when the last countdown unmounts.
 *  One second is enough for the seconds label, and the bar no longer depends on
 *  this ticker at all — see the drain animation in components/ApprovalClock.tsx. */
export function subscribeClock(listener: TickListener): () => void {
  tickListeners.add(listener)
  if (tickTimer === null) {
    // Baseline for the first paint: a fresh countdown must not render against
    // the stale `now` whatever counted down here last.
    currentNow = Date.now()
    tickTimer = setInterval(refreshClock, 1_000)
  }
  return () => {
    tickListeners.delete(listener)
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }
}
