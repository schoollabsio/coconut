import type { AuthModel } from '../../protocol'
import { Chevron, Label } from './pieces'

/**
 * Model dropdown for the selected provider. `configured` decides which empty
 * state to explain: a signed-in provider with no models still applies (leaving
 * the model unset), an unsigned one just has nothing to list yet.
 */
export function ModelSelect({
  models,
  value,
  configured,
  onPick,
}: {
  models: AuthModel[]
  value: string
  configured: boolean
  onPick: (id: string) => void
}) {
  const none = models.length === 0
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <Label>Model</Label>
        {!value && !none && <span className="text-[10px] text-warn">pick a model to apply</span>}
      </div>
      <div className="relative mt-1.5">
        <select
          value={value}
          onChange={(e) => onPick(e.target.value)}
          disabled={none && !configured}
          className="w-full appearance-none rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60 disabled:opacity-50"
        >
          <option value="" disabled>
            choose a model…
          </option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={m.id}>
              {m.id}
              {m.name && m.name !== m.id ? ` — ${m.name}` : ''}
            </option>
          ))}
        </select>
        <Chevron />
      </div>
      {none && configured && (
        <p className="mt-1.5 text-[10px] text-faint">no models listed — applying leaves the model unset</p>
      )}
      {none && !configured && <p className="mt-1.5 text-[10px] text-faint">sign in to list available models</p>}
    </section>
  )
}
