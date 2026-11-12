import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd, type AuthModel, type AuthStatusResult } from '../../protocol'
import { store, useUIState } from '../../store'
import { stripModelRef } from '../../modelRef'
import { readProviderModel } from '../../yamlPatch'

/**
 * The auth-command plumbing behind the Provider pane: provider/model selection,
 * `auth.status` polling and `auth.models` fetching, with the monotonic guards
 * that keep a late response from clobbering a newer one. Lives outside the panel
 * so the panel is layout and wiring only.
 */
export function useProviderAuth(client: BackendClient) {
  const settingsYaml = useUIState((s) => s.settingsYaml)
  const loginResult = useUIState((s) => s.auth.login?.result ?? null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [statusError, setStatusError] = useState<string | null>(null)
  const defaulted = useRef(false)
  const modelsSeq = useRef(0)

  const fetchStatus = useCallback(() => {
    void client
      .command<AuthStatusResult>(Cmd.AuthStatus, {})
      .then((resp) => {
        if (!resp.ok || !resp.payload) {
          setStatusError(resp.error?.message ?? 'failed to load provider status')
          return
        }
        store.setAuthStatus(resp.payload)
        setStatusError(null)
        // Default the selection to the active provider, once — and seed the
        // model from the saved settings so the dropdown reflects what the
        // session is actually running.
        if (!defaulted.current && resp.payload.activeProvider) {
          defaulted.current = true
          setProvider(resp.payload.activeProvider)
          const saved = readProviderModel(store.state.settingsYaml ?? '')
          if (saved.provider === resp.payload.activeProvider && saved.model) {
            setModel(stripModelRef(saved.model, saved.provider))
          }
        }
      })
      .catch((err) => setStatusError(String(err)))
  }, [client])

  const fetchModels = useCallback(
    (pid: string) => {
      const seq = ++modelsSeq.current
      void client
        .command<{ models: AuthModel[] }>(Cmd.AuthModels, { provider: pid })
        .then((resp) => {
          if (seq !== modelsSeq.current) return
          store.setAuthModels(resp.ok && resp.payload ? resp.payload.models ?? [] : [], pid)
        })
        .catch(() => {
          if (seq === modelsSeq.current) store.setAuthModels([], pid)
        })
    },
    [client],
  )

  // Credential status on mount and whenever settings change (e.g. a save from
  // the Advanced pane re-resolved credentials).
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus, settingsYaml])

  // Models for the selected provider.
  useEffect(() => {
    if (provider) fetchModels(provider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  // When a login completes, re-pull status so the chip flips to signed-in.
  useEffect(() => {
    if (loginResult === 'completed') fetchStatus()
  }, [loginResult, fetchStatus])

  return { provider, setProvider, model, setModel, statusError, fetchStatus }
}
