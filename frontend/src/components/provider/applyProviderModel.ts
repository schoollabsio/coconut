import { BackendClient } from '../../backend'
import { Cmd, type SettingsValidateResult } from '../../protocol'
import { withProviderModel } from '../../yamlPatch'

/**
 * Whether Apply can run at all: a provider must be selected, and if the
 * provider listed models one must be picked too (a provider that lists none
 * still applies, leaving `model:` unset). The panel adds "not busy" and "no
 * login in flight" on top of this.
 */
export function readyToApply(provider: string, model: string, hasModels: boolean): boolean {
  return !!provider && (!hasModels || !!model)
}

/**
 * Rewrite the live settings.yaml with the chosen provider/model and save it.
 * The freshest text is re-read first: the Advanced pane may hold unsaved edits,
 * and saving over them would lose user work. Resolves to null on success, or to
 * the one-line message to show instead.
 */
export async function saveProviderModel(
  client: BackendClient,
  provider: string,
  model: string,
  fallbackYaml: string,
): Promise<string | null> {
  const cur = await client.command<{ yaml: string }>(Cmd.SettingsGet, {})
  const base = cur.ok && cur.payload ? cur.payload.yaml : fallbackYaml
  const resp = await client.command<SettingsValidateResult>(Cmd.SettingsSave, {
    yaml: withProviderModel(base, provider, model || null),
  })
  if (resp.ok) return null
  // A rejected save shows the validator's problems joined, else the raw error.
  return resp.payload?.problems?.map((p) => p.message).join(' · ') || resp.error?.message || 'save failed'
}
