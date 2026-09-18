import { useEffect } from 'react'
import type { BackendClient } from './backend'
import { Cmd, Ev, type AuthStatusResult } from './protocol'
import { store, useUIState } from './store'

/**
 * useAuthStatus — keeps the store's provider credential status populated
 * outside the settings modal (the header chip reads it):
 *   - fetches once on mount when nothing is cached yet
 *   - refetches whenever settings change (a save can migrate an apiKey
 *     into the credential store or switch the active provider)
 * Fire-and-forget: a failed fetch just leaves the status empty (the chip
 * shows the neutral state; the Provider panel reports its own errors).
 */
export function useAuthStatus(client: BackendClient): AuthStatusResult | null {
  const status = useUIState((s) => s.auth.status)

  useEffect(() => {
    let cancelled = false

    const refresh = () => {
      void client
        .command<AuthStatusResult>(Cmd.AuthStatus, {})
        .then((resp) => {
          if (!cancelled && resp.ok && resp.payload) store.setAuthStatus(resp.payload)
        })
        .catch(() => {
          /* header chip falls back to the neutral state */
        })
    }

    if (!store.state.auth.status) refresh()

    const off = client.onMessage((msg) => {
      if (msg.type === 'event' && msg.name === Ev.SettingsChanged) {
        // Credentials may have moved or the active provider changed —
        // drop the cache and re-resolve.
        store.setAuthStatus(null)
        refresh()
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [client])

  return status
}
