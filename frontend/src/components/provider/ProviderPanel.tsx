import { useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd, type AuthLoginStartPayload } from '../../protocol'
import { store, useUIState, type AuthLoginFlow } from '../../store'
import { ApplyFooter } from './ApplyFooter'
import { readyToApply, saveProviderModel } from './applyProviderModel'
import { CredentialCard } from './CredentialCard'
import { LoginFlowCard } from './LoginFlowCard'
import { ModelSelect } from './ModelSelect'
import { ProviderSelect } from './ProviderSelect'
import { useProviderAuth } from './useProviderAuth'

/**
 * Settings → Provider pane: pick a provider, sign in (OAuth or API key), pick a
 * model, Apply. Credential truth lives in the store (`auth.status` /
 * `auth.models` results and the in-flight login flow); this component is the
 * wiring between it and the auth commands — the status/model fetching is in
 * `useProviderAuth`, and each block of the pane is its own file beside it.
 */
export function ProviderPanel({ client }: { client: BackendClient }) {
  const auth = useUIState((s) => s.auth)
  const settingsYaml = useUIState((s) => s.settingsYaml)
  const { provider, setProvider, model, setModel, statusError, fetchStatus } = useProviderAuth(client)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  const providers = auth.status?.providers ?? []
  const activeId = auth.status?.activeProvider
  const selected = providers.find((p) => p.id === provider)
  // The flow belonging to the selected provider. A settled flow still counts as
  // present — its banner offers retry/refresh, and while it is on screen the
  // card must not offer a competing sign out. Only an in-flight one blocks
  // starting another sign in, so a failed attempt stays retryable.
  const flow = flowFor(auth.login, provider)
  const flowPresent = flow !== null
  const flowActive = flowPresent && flow.result === null
  const models = auth.modelsFor === provider ? auth.models : []

  const pickProvider = (id: string) => {
    setProvider(id)
    setModel('')
    setLoginError(null)
    // The credential card is keyed per provider, so switching remounts it and
    // drops the key draft, its message line and any armed sign-out confirm.
  }

  const startLogin = () => {
    setLoginError(null)
    void client
      .command<AuthLoginStartPayload & { loginId: string }>(Cmd.AuthLogin, { provider, authType: 'oauth' })
      .then((resp) => {
        if (resp.ok && resp.payload) {
          store.beginAuthLogin(resp.payload)
        } else {
          setLoginError(resp.error?.message ?? 'failed to start sign in')
        }
      })
      .catch((err) => setLoginError(String(err)))
  }

  const apply = async () => {
    if (!applyEnabled) return
    setApplyBusy(true)
    setApplyError(null)
    try {
      const problem = await saveProviderModel(client, provider, model, settingsYaml ?? '')
      if (problem) {
        setApplyError(problem)
      } else {
        // settings.changed lands → the status effect in useProviderAuth re-runs.
        store.clearAuthLogin()
      }
    } catch (err) {
      setApplyError(String(err))
    } finally {
      setApplyBusy(false)
    }
  }

  // Apply needs a provider (and a model, when the provider listed models to pick
  // from) — see readyToApply — plus no login in flight and no save running.
  const applyEnabled = readyToApply(provider, model, models.length > 0) && !applyBusy && !flowActive

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
        <ProviderSelect
          providers={providers}
          value={provider}
          activeId={activeId}
          statusError={statusError}
          onPick={pickProvider}
        />
        {selected && (
          <CredentialCard
            key={selected.id}
            client={client}
            selected={selected}
            flowPresent={flowPresent}
            flowActive={flowActive}
            loginError={loginError}
            onStartLogin={startLogin}
            onStatusChanged={fetchStatus}
          />
        )}
        {flow && (
          <LoginFlowCard
            client={client}
            flow={flow}
            onDone={fetchStatus}
            onRetry={startLogin}
            onDismiss={() => store.clearAuthLogin()}
          />
        )}
        <ModelSelect models={models} value={model} configured={!!selected?.configured} onPick={setModel} />
      </div>
      <ApplyFooter disabled={!applyEnabled} busy={applyBusy} error={applyError} onApply={() => void apply()} />
    </div>
  )
}

/** The login flow on screen for the selected provider, if it is that provider's. */
function flowFor(login: AuthLoginFlow | null, provider: string): AuthLoginFlow | null {
  return login && login.provider === provider ? login : null
}
