import { useSyncExternalStore } from 'react'
import type { Budgetable } from '../autoApprove'
import { clockSnapshot, clockView, subscribeClock } from '../approvalClock'
import { store, useUIState } from '../store'

/**
 * ApprovalClock — the countdown strip on an approval card and in the panel.
 *
 * The bar drains on a CSS animation sized from the armed budget, not off the
 * per-second ticker: it reaches zero at exactly the instant the store's timer
 * fires the decision. Ticking the bar through React could never land there — a
 * whole-second ticker plus a rounded percent means the last frame painted before
 * expiry always still has a slice left. The ticker now only keeps the seconds
 * label current, and each tick re-seeks the animation to the true elapsed time
 * (a negative animation-delay), which also heals a window that was throttled
 * while hidden.
 * Renders nothing while auto-approve is off, so default cards are unchanged —
 * which is why `className` styles the root here rather than the component
 * carrying a margin that would show up as a gap in an idle card.
 */
const noTick = () => () => {}

export function ApprovalClock({ approval, className = '' }: { approval: Budgetable; className?: string }) {
  const auto = useUIState((s) => s.autoApprove)
  const deadline = auto.deadlines[approval.id]
  const running = auto.on && deadline?.mode === 'running'
  // Only a running clock subscribes: with the mode off — the default — no card
  // ticks at all, and the shared interval never starts. The wall clock arrives
  // as a subscription rather than a Date.now() call here, because React
  // requires render to be pure.
  const now = useSyncExternalStore(running ? subscribeClock : noTick, clockSnapshot, clockSnapshot)
  const view = clockView(deadline, auto.on, now)
  if (view.kind === 'idle') return null

  if (view.kind === 'fired') {
    // The track stays, empty, so the strip does not jump as the card resolves.
    return (
      <div className={`min-w-0 flex-1 text-faint ${className}`}>
        <div>{view.label}</div>
        <div className="mt-1 h-[2px] w-full overflow-hidden rounded bg-line" />
      </div>
    )
  }

  if (view.kind !== 'running') {
    const hint =
      view.kind === 'manual'
        ? 'Auto-approve is forward-only: this request was already waiting when the mode was turned on, so no timer will ever fire it.'
        : 'You took this countdown back — approve or dismiss it yourself.'
    return (
      <div className={`min-w-0 flex-1 text-faint ${className}`} title={hint}>
        {view.label}
      </div>
    )
  }

  // Where this clock sits in its own budget, in ms since it was armed.
  const elapsed = Math.max(0, Math.min(view.totalMs, view.totalMs - view.leftMs))

  return (
    <div className={`min-w-0 flex-1 ${className}`}>
      <div className="flex items-center gap-2 text-warn">
        <span>{view.label}</span>
        <button
          type="button"
          onClick={() => store.cancelApprovalClock(approval.id)}
          title="Stop the countdown — you will approve or dismiss this one yourself"
          className="text-dim underline decoration-linestrong underline-offset-2 hover:text-mute transition-colors"
        >
          cancel timer
        </button>
      </div>
      <div className="mt-1 h-[2px] w-full overflow-hidden rounded bg-line">
        {/* .clock-drain supplies the name/timing/fill; the armed budget and the
            elapsed offset are per-clock, so they go inline. A negative delay
            starts the animation partway through, so a mid-countdown remount (or
            the per-second tick) resumes at the true remaining width instead of
            restarting from full. `width` alone is the fallback for a renderer
            that does not run the animation. */}
        <div
          className="clock-drain h-full bg-warn"
          style={{ width: `${view.percent}%`, animationDuration: `${view.totalMs}ms`, animationDelay: `${-elapsed}ms` }}
        />
      </div>
    </div>
  )
}
