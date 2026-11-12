/**
 * Apply bar. `disabled` is decided by the panel (it needs provider, model,
 * login-flow and busy state together); this is just the bar and its error text.
 */
export function ApplyFooter({
  disabled,
  busy,
  error,
  onApply,
}: {
  disabled: boolean
  busy: boolean
  error: string | null
  onApply: () => void
}) {
  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-2.5 shrink-0">
      <span className="text-[10px] text-faint">applying restarts the agent with the new provider</span>
      <div className="flex items-center gap-3">
        {error && <span className="text-[11px] text-danger">{error}</span>}
        <button
          onClick={onApply}
          disabled={disabled}
          className="px-4 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover text-onaccent transition-colors disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}
