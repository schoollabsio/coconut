import { useSyncExternalStore } from 'react'
import type { Budgetable } from '../autoApprove'
import { clockSnapshot, clockView, subscribeClock } from '../approvalClock'
import { store, useUIState } from '../store'

/**
 * ApprovalClock — the countdown strip on an approval card and in the panel.
 *
 * It re-renders on a shared per-second ticker rather than pushing per-second
 * updates through the store: only this line moves, one interval serves the
 * window, and it stops when the last card unmounts.
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
  const tick = useSyncExternalStore(running ? subscribeClock : noTick, clockSnapshot, clockSnapshot)
  const view = clockView(approval, deadline, auto.on, tick * 1000)
  if (view.kind === 'idle') return null

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
        <div className="h-full bg-warn transition-[width] duration-1000 ease-linear" style={{ width: `${view.percent}%` }} />
      </div>
    </div>
  )
}
