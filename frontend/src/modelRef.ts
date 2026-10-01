import type { AuthModel } from './protocol'

/**
 * modelRef — helpers for the settings.yaml `model:` value, which may be a
 * bare id (`kimi-k3`), provider-prefixed (`github-copilot/kimi-k3`), or
 * suffixed (`kimi-k3:thinking`). AuthModel.id is always the bare id.
 */

/** Strip any `:suffix` and the active provider's `provider/` prefix so the
 *  result can be matched against AuthModel.id. A prefix naming a DIFFERENT
 *  provider is left intact — it can't match this provider's models. */
export function stripModelRef(model: string, provider: string): string {
  let m = model
  const colon = m.lastIndexOf(':')
  if (colon > 0) m = m.slice(0, colon)
  const prefix = `${provider}/`
  if (provider && m.startsWith(prefix)) m = m.slice(prefix.length)
  return m
}

/** Display name for a stored model ref: the friendly name when the
 *  provider's model list is loaded and names it differently, else the bare
 *  id. Returns '' for an unset model. */
export function modelDisplayName(model: string, provider: string, models: AuthModel[]): string {
  if (!model) return ''
  const id = stripModelRef(model, provider)
  const found = models.find((m) => m.id === id)
  return found && found.name && found.name !== found.id ? found.name : id
}
