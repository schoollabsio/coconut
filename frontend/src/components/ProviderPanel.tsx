import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendClient } from '../backend'
import {
  Cmd,
  type AuthEvent,
  type AuthLoginStartPayload,
  type AuthModel,
  type AuthProviderStatus,
  type AuthPrompt,
  type AuthStatusResult,
  type SettingsValidateResult,
} from '../protocol'
import { store, useUIState, type AuthLoginFlow } from '../store'
import { withProviderModel } from '../yamlPatch'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function providerName(p: AuthProviderStatus): string {
  return p.name && p.name !== p.id ? p.name : p.id
}

// ---------------------------------------------------------------------------
// ProviderPanel — structured provider / auth / model UI
// ---------------------------------------------------------------------------

export function ProviderPanel({ client }: { client: BackendClient }) {
  const auth = useUIState((s) => s.auth)
  const settingsYaml = useUIState((s) => s.settingsYaml)

  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ level: 'ok' | 'err'; text: string } | null>(null)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [confirmingOut, setConfirmingOut] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaulted = useRef(false)

  // Monotonic guards so late responses never clobber newer ones.
  const modelsSeq = useRef(0)

  const fetchStatus = useCallback(() => {
    void client
      .command<AuthStatusResult>(Cmd.AuthStatus, {})
      .then((resp) => {
        if (resp.ok && resp.payload) {
          store.setAuthStatus(resp.payload)
          setStatusError(null)
          // Default the selection to the active provider, once.
          if (!defaulted.current && resp.payload.activeProvider) {
            defaulted.current = true
            setProvider(resp.payload.activeProvider)
          }
        } else {
          setStatusError(resp.error?.message ?? 'failed to load provider status')
        }
      })
      .catch((err) => setStatusError(String(err)))
  }, [])

  const fetchModels = useCallback(
    (pid: string) => {
      const seq = ++modelsSeq.current
      void client
        .command<{ models: AuthModel[] }>(Cmd.AuthModels, { provider: pid })
        .then((resp) => {
          if (seq !== modelsSeq.current) return
          if (resp.ok && resp.payload) {
            store.setAuthModels(resp.payload.models ?? [], pid)
          } else {
            store.setAuthModels([], pid)
          }
        })
        .catch(() => {
          if (seq === modelsSeq.current) store.setAuthModels([], pid)
        })
    },
    [],
  )

  // Load credential status on mount and whenever settings change
  // (e.g. a save from the Advanced pane re-resolved credentials).
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus, settingsYaml])

  // Reset the sign-out confirm when the selection changes or unmounting.
  useEffect(() => {
    setConfirmingOut(false)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [provider])

  // When a login completes, re-pull status so the chip flips to signed-in.
  const loginResult = auth.login?.result
  useEffect(() => {
    if (loginResult === 'completed') fetchStatus()
  }, [loginResult, fetchStatus])

  const providers = auth.status?.providers ?? []
  const activeId = auth.status?.activeProvider
  const selected = providers.find((p) => p.id === provider)
  const flow = auth.login && auth.login.provider === provider ? auth.login : null

  // Load models for the selected provider.
  useEffect(() => {
    if (provider) fetchModels(provider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

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

  const saveApiKey = async () => {
    if (!apiKey.trim() || keyBusy) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const resp = await client.command(Cmd.AuthSetApiKey, { provider, key: apiKey.trim() })
      if (resp.ok) {
        setApiKey('')
        setShowKey(false)
        setKeyMsg({ level: 'ok', text: 'API key saved to the credential store' })
        fetchStatus()
      } else {
        setKeyMsg({ level: 'err', text: resp.error?.message ?? 'failed to save key' })
      }
    } catch (err) {
      setKeyMsg({ level: 'err', text: String(err) })
    } finally {
      setKeyBusy(false)
    }
  }

  const askSignOut = () => {
    if (logoutBusy || flow !== null) return
    if (confirmingOut) return // the second click path calls signOut directly
    setConfirmingOut(true)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmingOut(false), 3500)
  }

  const signOut = async () => {
    setConfirmingOut(false)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    if (logoutBusy) return
    setLogoutBusy(true)
    try {
      const resp = await client.command(Cmd.AuthLogout, { provider })
      if (resp.ok) {
        setKeyMsg({ level: 'ok', text: `Signed out of ${provider}` })
        fetchStatus()
      } else {
        setKeyMsg({ level: 'err', text: resp.error?.message ?? 'sign out failed' })
      }
    } catch (err) {
      setKeyMsg({ level: 'err', text: String(err) })
    } finally {
      setLogoutBusy(false)
    }
  }

  const apply = async () => {
    if (applyBusy || !provider) return
    setApplyBusy(true)
    setApplyError(null)
    try {
      // Pull the freshest YAML (the Advanced pane may have unsaved edits —
      // saving over them would lose user work).
      const cur = await client.command<{ yaml: string }>(Cmd.SettingsGet, {})
      const base = cur.ok && cur.payload ? cur.payload.yaml : settingsYaml ?? ''
      const next = withProviderModel(base, provider, model || null)
      const resp = await client.command<SettingsValidateResult>(Cmd.SettingsSave, { yaml: next })
      if (!resp.ok) {
        const problems = resp.payload?.problems?.map((p) => p.message).join(' · ')
        setApplyError(problems ?? resp.error?.message ?? 'save failed')
        return
      }
      // settings.changed lands → fetchStatus re-runs via the effect.
      store.clearAuthLogin()
    } catch (err) {
      setApplyError(String(err))
    } finally {
      setApplyBusy(false)
    }
  }

  const models = auth.modelsFor === provider ? auth.models : []

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
        {/* Provider */}
        <section>
          <Label>Provider</Label>
          <div className="relative mt-1.5">
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                setModel('')
                setKeyMsg(null)
                setApiKey('')
                setLoginError(null)
              }}
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

        {/* Credential */}
        {selected && (
          <section className="rounded-xl border border-line bg-base/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink">{providerName(selected)}</span>
                <StatusChip p={selected} />
              </div>
              {selected.configured && (
                <button
                  onClick={confirmingOut ? () => void signOut() : askSignOut}
                  disabled={logoutBusy || flow !== null}
                  className={`text-[11px] transition-colors disabled:opacity-40 ${
                    confirmingOut
                      ? 'text-danger font-medium underline'
                      : 'text-dim hover:text-danger'
                  }`}
                >
                  {logoutBusy ? 'signing out…' : confirmingOut ? 'confirm sign out?' : 'sign out'}
                </button>
              )}
            </div>

            {selected.configured && (
              <p className="text-[11px] text-mute">
                signed in via {selected.source || selected.type || 'credential store'}
              </p>
            )}

            {!selected.configured && selected.oauth && (
              <div className="space-y-1.5">
                <button
                  onClick={startLogin}
                  disabled={flow !== null && flow.result === null}
                  className="px-3 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover text-onaccent transition-colors disabled:opacity-50"
                >
                  Sign in
                </button>
                {loginError && <p className="text-[11px] text-danger">{loginError}</p>}
              </div>
            )}

            {selected.apiKey && !selected.configured && flow === null && (
              <div className="space-y-1.5 pt-1">
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={`API key for ${providerName(selected)}`}
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
                    onClick={() => void saveApiKey()}
                    disabled={!apiKey.trim() || keyBusy}
                    className="px-3 py-1.5 rounded-lg text-xs border border-line text-mute hover:text-ink hover:bg-surface2 transition-colors disabled:opacity-40"
                  >
                    {keyBusy ? 'saving…' : 'Save key'}
                  </button>
                </div>
                {keyMsg && (
                  <p className={`text-[11px] ${keyMsg.level === 'ok' ? 'text-accent' : 'text-danger'}`}>{keyMsg.text}</p>
                )}
                {selected.oauth && (
                  <p className="text-[10px] text-faint">or use the API key above — sign in with OAuth instead</p>
                )}
              </div>
            )}

            {selected.apiKey && !selected.oauth && keyMsg === null && (
              <p className="text-[11px] text-mute">API-key provider — enter a key above</p>
            )}
          </section>
        )}

        {/* Login flow */}
        {flow && (
          <LoginFlow
            client={client}
            flow={flow}
            onDone={() => fetchStatus()}
            onRetry={startLogin}
            onDismiss={() => store.clearAuthLogin()}
          />
        )}

        {/* Model */}
        <section>
          <div className="flex items-baseline justify-between">
            <Label>Model</Label>
            {provider === activeId && !model && <span className="text-[10px] text-faint">blank = provider default</span>}
          </div>
          <div className="relative mt-1.5">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={models.length === 0 && !selected?.configured}
              className="w-full appearance-none rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60 disabled:opacity-50"
            >
              <option value="">provider default</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={m.id}>
                  {m.id}
                  {m.name && m.name !== m.id ? ` — ${m.name}` : ''}
                </option>
              ))}
            </select>
            <Chevron />
          </div>
          {models.length === 0 && selected?.configured && (
            <p className="mt-1.5 text-[10px] text-faint">no models listed — leave as default</p>
          )}
          {models.length === 0 && !selected?.configured && (
            <p className="mt-1.5 text-[10px] text-faint">sign in to list available models</p>
          )}
        </section>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-line px-5 py-2.5 shrink-0">
        <span className="text-[10px] text-faint">applying restarts the agent with the new provider</span>
        <div className="flex items-center gap-3">
          {applyError && <span className="text-[11px] text-danger">{applyError}</span>}
          <button
            onClick={() => void apply()}
            disabled={!provider || applyBusy || (flow !== null && flow.result === null)}
            className="px-4 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover text-onaccent transition-colors disabled:opacity-50"
          >
            {applyBusy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-mono uppercase tracking-wider text-faint">{children}</div>
}

function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dim"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// LoginFlow — renders one in-flight auth.login.* flow
// ---------------------------------------------------------------------------

function LoginFlow({
  client,
  flow,
  onDone,
  onRetry,
  onDismiss,
}: {
  client: BackendClient
  flow: AuthLoginFlow
  onDone: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const prompt = flow.prompt

  const submit = () => {
    if (!prompt || sending) return
    setSending(true)
    setError(null)
    void client
      .command(Cmd.AuthLoginPrompt, { promptId: prompt.promptId, value: answer })
      .then(() => setAnswer(''))
      .catch((err) => setError(String(err)))
      .finally(() => setSending(false))
  }

  const cancelStep = () => {
    if (!prompt || sending) return
    setSending(true)
    void client
      .command(Cmd.AuthLoginPrompt, { promptId: prompt.promptId, cancel: true })
      .finally(() => setSending(false))
  }

  const cancelLogin = () => {
    void client.command(Cmd.AuthLoginCancel, { loginId: flow.loginId })
  }

  const terminal = flow.result !== null
  const awaitingApproval = flow.steps.some((s) => s.type === 'device_code' && s.userCode)

  return (
    <section className="rounded-xl border border-accent/40 bg-base/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">Signing in…</span>
          {!terminal && (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-dim">
              <Spinner /> {awaitingApproval ? 'waiting for approval in your browser' : 'waiting for provider'}
            </span>
          )}
        </div>
        {!terminal && (
          <button onClick={cancelLogin} className="text-[11px] text-dim hover:text-danger transition-colors">
            cancel
          </button>
        )}
      </div>

      {flow.steps.length > 0 && (
        <div className="space-y-1.5">
          {flow.steps.map((ev, i) => (
            <StepLine key={i} ev={ev} />
          ))}
        </div>
      )}

      {prompt && !terminal && <PromptForm prompt={prompt} value={answer} setValue={setAnswer} sending={sending} error={error} onSubmit={submit} onSkip={cancelStep} />}

      {terminal && (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs border ${
            flow.result === 'completed'
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          <span className="shrink-0">{flow.result === 'completed' ? '✓' : '✕'}</span>
          <span>
            {flow.result === 'completed'
              ? `signed in — ${flow.provider}`
              : flow.result === 'cancelled'
                ? 'sign in cancelled'
                : flow.message || 'sign in failed'}
          </span>
          <span className="ml-auto flex items-center gap-3 shrink-0">
            {flow.result === 'completed' ? (
              <button onClick={onDone} className="text-[10px] underline opacity-80 hover:opacity-100">
                refresh
              </button>
            ) : (
              <button onClick={onRetry} className="text-[10px] underline opacity-80 hover:opacity-100">
                try again
              </button>
            )}
            <button onClick={onDismiss} className="text-[10px] underline opacity-50 hover:opacity-100">
              dismiss
            </button>
          </span>
        </div>
      )}
    </section>
  )
}

function StatusChip({ p }: { p: AuthProviderStatus }) {
  if (p.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 border border-accent/30 px-2 py-0.5 text-[10px] text-accent">
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
        {p.source || p.type || 'signed in'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[10px] text-dim">
      <span className="w-1.5 h-1.5 rounded-full bg-faint" />
      not signed in
    </span>
  )
}

function PromptForm({
  prompt,
  value,
  setValue,
  sending,
  error,
  onSubmit,
  onSkip,
}: {
  prompt: { promptId: string; prompt: AuthPrompt }
  value: string
  setValue: (v: string) => void
  sending: boolean
  error: string | null
  onSubmit: () => void
  onSkip: () => void
}) {
  return (
    <div className="space-y-2 pt-1 border-t border-line/60">
      {(prompt.prompt.message ?? prompt.prompt.label) && (
        <p className="text-[11px] text-mute">{prompt.prompt.message ?? prompt.prompt.label}</p>
      )}
      {prompt.prompt.type === 'select' ? (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full appearance-none rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60"
        >
          <option value="">choose…</option>
          {(prompt.prompt.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={prompt.prompt.type === 'secret' ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          placeholder={prompt.prompt.placeholder || prompt.prompt.label || 'answer'}
          spellCheck={false}
          autoFocus
          className="w-full rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60 placeholder:text-faint"
        />
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={sending}
          className="px-3 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover text-onaccent transition-colors disabled:opacity-50"
        >
          {sending ? '…' : 'Submit'}
        </button>
        <button
          onClick={onSkip}
          disabled={sending}
          className="px-3 py-1.5 rounded-lg text-xs border border-line text-mute hover:text-ink transition-colors disabled:opacity-40"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function StepLine({ ev }: { ev: AuthEvent }) {
  if (ev.type === 'auth_url' && ev.url) {
    return (
      <div className="text-xs text-mute space-y-1">
        {ev.message && <span>{ev.message}</span>}
        <a href={ev.url} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">
          {ev.url} ↗
        </a>
      </div>
    )
  }
  if (ev.type === 'device_code' && ev.userCode) {
    const link = ev.url || ev.verificationUri
    return (
      <div className="rounded-lg bg-surface2/60 border border-line px-3 py-2 space-y-1.5">
        <span className="block text-xs text-mute">
          {ev.message || 'Enter this code on the sign-in page, then come back — completion is detected automatically.'}
        </span>
        <div className="flex items-center gap-2">
          <code className="font-mono text-base tracking-widest text-ink select-all">{ev.userCode}</code>
          <span className="text-[10px] text-dim">click to copy</span>
        </div>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="block text-xs text-accent hover:underline break-all">
            {link} ↗
          </a>
        )}
      </div>
    )
  }
  if (ev.type === 'progress') {
    return <div className="text-[11px] text-dim">{ev.message}</div>
  }
  return <div className="text-xs text-mute">{ev.message}</div>
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V2C5.4 2 2 5.4 2 10h2z" />
    </svg>
  )
}
