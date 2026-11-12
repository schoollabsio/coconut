import { useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd } from '../../protocol'
import { CredentialMessage } from './pieces'

/**
 * API-key entry for a provider that accepts one and has no credential yet.
 * The draft key, the reveal toggle and the busy flag are purely this form's
 * business — the card owns the message line because signing out writes to it
 * too. The panel remounts the card per provider, which clears the draft.
 */
export function ApiKeyForm({
  client,
  providerId,
  providerLabel,
  hasOAuth,
  message,
  onMessage,
  onStatusChanged,
}: {
  client: BackendClient
  providerId: string
  providerLabel: string
  /** OAuth is also available — worth saying the key is the alternative. */
  hasOAuth: boolean
  message: CredentialMessage | null
  onMessage: (msg: CredentialMessage | null) => void
  onStatusChanged: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!apiKey.trim() || busy) return
    setBusy(true)
    onMessage(null)
    try {
      const resp = await client.command(Cmd.AuthSetApiKey, { provider: providerId, key: apiKey.trim() })
      if (resp.ok) {
        setApiKey('')
        setShowKey(false)
        onMessage({ level: 'ok', text: 'API key saved to the credential store' })
        onStatusChanged()
      } else {
        onMessage({ level: 'err', text: resp.error?.message ?? 'failed to save key' })
      }
    } catch (err) {
      onMessage({ level: 'err', text: String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex gap-2">
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={`API key for ${providerLabel}`}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 rounded-lg border border-line bg-base px-3 py-1.5 text-xs text-ink outline-none focus:border-accent/60 placeholder:text-faint"
        />
        <button
          onClick={() => setShowKey((v) => !v)}
          className="px-2 text-[10px] text-dim hover:text-mute transition-colors"
        >
          {showKey ? 'hide' : 'show'}
        </button>
        <button
          onClick={() => void save()}
          disabled={!apiKey.trim() || busy}
          className="px-3 py-1.5 rounded-lg text-xs border border-line text-mute hover:text-ink hover:bg-surface2 transition-colors disabled:opacity-40"
        >
          {busy ? 'saving…' : 'Save key'}
        </button>
      </div>
      {message && <p className={`text-[11px] ${message.level === 'ok' ? 'text-accent' : 'text-danger'}`}>{message.text}</p>}
      {hasOAuth && <p className="text-[10px] text-faint">or use the API key above — sign in with OAuth instead</p>}
    </div>
  )
}
