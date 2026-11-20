import { runningCount } from '../approvalClock'
import { store, useUIState } from '../store'

/**
 * The window's auto-approve switch (per-window by design: each window decides
 * for itself, so a fleet is protected one window at a time).
 *
 * Amber rather than green when on, because "on" here means a proposal can apply
 * itself with nobody reading it. The number is how many approvals are counting
 * down right now — "on" alone does not say whether anything is armed, and a
 * clock you cancelled is deliberately not counted.
 */
export function AutoApproveToggle() {
  const auto = useUIState((s) => s.autoApprove)
  const armed = runningCount(auto.deadlines)
  const title = auto.on
    ? `Auto-approve is on${armed ? ` — ${armed} counting down` : ''}: at zero, an approval applies itself as if you had clicked Approve. Click to stop every timer.`
    : 'Auto-approve is off: every approval waits for you. Turn it on to let an approval apply itself once its reading-time countdown runs out.'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={auto.on}
      aria-label="Auto-approve pending requests"
      title={title}
      onClick={() => store.setAutoApprove(!auto.on)}
      className={`no-drag shrink-0 flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] leading-none transition-colors ${
        auto.on
          ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20'
          : 'border-transparent text-faint hover:text-dim hover:bg-surface2'
      }`}
    >
      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5V12l3 2" />
      </svg>
      auto{auto.on && armed > 0 ? ` · ${armed}` : ''}
    </button>
  )
}
