import { useState } from 'react'
import { BackendClient } from '../../backend'
import type { AuthProviderStatus } from '../../protocol'
import { ApiKeyForm } from './ApiKeyForm'
import { CredentialMessage, StatusChip, providerName } from './pieces'
import { SignOutButton } from './SignOutButton'

/**
 * The selected provider's credential card: what we are signed in as, how to get
 * signed in (OAuth, or an API key where that is the only route), and the way
 * out. Keyed per provider by the panel, so switching provider resets the key
 * draft, the message line and an armed sign-out confirm.
 *
 * `flowPresent` (a flow card is showing, even a finished one) blocks signing
 * out; `flowActive` (still in flight) blocks starting another sign in — a failed
 * attempt must stay retryable from here.
 */
export function CredentialCard({
  client,
  selected,
  flowPresent,
  flowActive,
  loginError,
  onStartLogin,
  onStatusChanged,
}: {
  client: BackendClient
  selected: AuthProviderStatus
  flowPresent: boolean
  flowActive: boolean
  loginError: string | null
  onStartLogin: () => void
  onStatusChanged: () => void
}) {
  const [message, setMessage] = useState<CredentialMessage | null>(null)
  const showKeyForm = offersKeyForm(selected, flowPresent)

  return (
    <section className="rounded-xl border border-line bg-base/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">{providerName(selected)}</span>
          <StatusChip p={selected} />
        </div>
        {selected.configured && (
          <SignOutButton
            client={client}
            providerId={selected.id}
            flowPresent={flowPresent}
            onMessage={setMessage}
            onStatusChanged={onStatusChanged}
          />
        )}
      </div>

      {selected.configured && <p className="text-[11px] text-mute">signed in via {signedInVia(selected)}</p>}

      {offersSignIn(selected) && (
        <div className="space-y-1.5">
          <button
            onClick={onStartLogin}
            disabled={flowActive}
            className="px-3 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover text-onaccent transition-colors disabled:opacity-50"
          >
            Sign in
          </button>
          {loginError && <p className="text-[11px] text-danger">{loginError}</p>}
        </div>
      )}

      {showKeyForm && (
        <ApiKeyForm
          client={client}
          providerId={selected.id}
          providerLabel={providerName(selected)}
          hasOAuth={selected.oauth}
          message={message}
          onMessage={setMessage}
          onStatusChanged={onStatusChanged}
        />
      )}

      {nagsForKey(selected, message) && (
        <p className="text-[11px] text-mute">API-key provider — enter a key above</p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The card's affordance matrix. Each condition is mutual-exclusion logic over
// (configured, oauth, apiKey, flow) — named here so the render reads as intent
// and each rule can be read (or reused) on its own.
// ---------------------------------------------------------------------------

/** An unsigned provider that speaks OAuth offers the browser sign-in. */
function offersSignIn(p: AuthProviderStatus): boolean {
  return !p.configured && p.oauth
}

/**
 * An unsigned provider that accepts a key offers the key form — unless a login
 * flow card is on screen, which owns the interaction.
 */
function offersKeyForm(p: AuthProviderStatus, flowPresent: boolean): boolean {
  return p.apiKey && !p.configured && !flowPresent
}

/**
 * A key-only provider with nothing yet to report gets the nudge. Kept exactly
 * as before the split: it keys on the provider's capability, not on whether the
 * form is actually rendering.
 */
function nagsForKey(p: AuthProviderStatus, message: CredentialMessage | null): boolean {
  return p.apiKey && !p.oauth && message === null
}

/** Where a credential came from, in pi's words. */
function signedInVia(p: AuthProviderStatus): string {
  return p.source || p.type || 'credential store'
}
