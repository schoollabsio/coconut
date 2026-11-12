/** How a login ended, with the one action that makes sense for each outcome. */
export function LoginOutcome({
  result,
  provider,
  message,
  onDone,
  onRetry,
  onDismiss,
}: {
  result: 'completed' | 'cancelled' | 'failed'
  provider: string
  message?: string
  /** Re-pull auth.status so the chip flips to signed-in. */
  onDone: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const ok = result === 'completed'
  const text = ok
    ? `signed in — ${provider}`
    : result === 'cancelled'
      ? 'sign in cancelled'
      : message || 'sign in failed'
  return (
    <div
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs border ${
        ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'
      }`}
    >
      <span className="shrink-0">{ok ? '✓' : '✕'}</span>
      <span>{text}</span>
      <span className="ml-auto flex items-center gap-3 shrink-0">
        <button onClick={ok ? onDone : onRetry} className="text-[10px] underline opacity-80 hover:opacity-100">
          {ok ? 'refresh' : 'try again'}
        </button>
        <button onClick={onDismiss} className="text-[10px] underline opacity-50 hover:opacity-100">
          dismiss
        </button>
      </span>
    </div>
  )
}
