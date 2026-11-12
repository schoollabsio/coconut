import type { AuthProviderStatus } from '../../protocol'
import { Chevron, Label, providerName } from './pieces'

/**
 * Provider dropdown. Options are sorted by display name and the running
 * provider is suffixed "(current)"; picking one resets the model and the
 * credential card (the panel remounts it).
 */
export function ProviderSelect({
  providers,
  value,
  activeId,
  statusError,
  onPick,
}: {
  providers: AuthProviderStatus[]
  value: string
  activeId?: string
  statusError: string | null
  onPick: (id: string) => void
}) {
  return (
    <section>
      <Label>Provider</Label>
      <div className="relative mt-1.5">
        <select
          value={value}
          onChange={(e) => onPick(e.target.value)}
          disabled={providers.length === 0}
          className="w-full appearance-none rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60 disabled:opacity-50"
        >
          {providers.length === 0 && <option value="">loading…</option>}
          {[...providers]
            .sort((a, b) => providerName(a).localeCompare(providerName(b)))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {providerName(p)}
                {p.id === activeId ? '  (current)' : ''}
              </option>
            ))}
        </select>
        <Chevron />
      </div>
      {statusError && <div className="mt-1.5 text-xs text-danger">{statusError}</div>}
    </section>
  )
}
