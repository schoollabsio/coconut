import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd } from '../../protocol'
import { CredentialMessage } from './pieces'

/** How long "confirm sign out?" stays armed before it reverts. */
const CONFIRM_MS = 3500

/**
 * Two-step sign out: the first click arms, the second one runs `auth.logout`.
 * The armed state and its revert timer are local to the button, and the result
 * is reported to the card so it can render it as the card's message line.
 */
export function SignOutButton({
  client,
  providerId,
  flowPresent,
  onMessage,
  onStatusChanged,
}: {
  client: BackendClient
  providerId: string
  /** A login flow is showing for this provider — signing out now would race it. */
  flowPresent: boolean
  onMessage: (msg: CredentialMessage | null) => void
  onStatusChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Never leave an armed confirm behind on a provider switch or unmount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfirming(false)
    const pending = timer.current
    return () => {
      if (pending) clearTimeout(pending)
    }
  }, [providerId])

  const ask = () => {
    if (busy || flowPresent) return
    if (confirming) return // the second click path calls signOut directly
    setConfirming(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirming(false), CONFIRM_MS)
  }

  const signOut = useCallback(async () => {
    setConfirming(false)
    if (timer.current) clearTimeout(timer.current)
    setBusy(true)
    try {
      const resp = await client.command(Cmd.AuthLogout, { provider: providerId })
      if (resp.ok) {
        onMessage({ level: 'ok', text: `Signed out of ${providerId}` })
        onStatusChanged()
      } else {
        onMessage({ level: 'err', text: resp.error?.message ?? 'sign out failed' })
      }
    } catch (err) {
      onMessage({ level: 'err', text: String(err) })
    } finally {
      setBusy(false)
    }
  }, [client, providerId, onMessage, onStatusChanged])

  return (
    <button
      onClick={() => void (confirming ? signOut() : ask())}
      disabled={busy || flowPresent}
      className={`text-[11px] transition-colors disabled:opacity-40 ${
        confirming ? 'text-danger font-medium underline' : 'text-dim hover:text-danger'
      }`}
    >
      {busy ? 'signing out…' : confirming ? 'confirm sign out?' : 'sign out'}
    </button>
  )
}
