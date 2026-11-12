import { useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd } from '../../protocol'
import type { AuthLoginFlow } from '../../store'
import { LoginOutcome } from './LoginOutcome'
import { LoginPromptForm } from './LoginPromptForm'
import { LoginStepLine } from './LoginStepLine'
import { Spinner } from './pieces'

/**
 * One in-flight `auth.login.*` flow: the step log so far, the prompt the helper
 * is waiting on (if any), and once settled, the outcome banner. Rendered only
 * while the store holds a flow for the selected provider.
 */
export function LoginFlowCard({
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
  const terminal = flow.result !== null
  // A device-code step means the browser holds the next move, not us.
  const awaitingApproval = flow.steps.some((s) => s.type === 'device_code' && s.userCode)

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

  /** Skip this prompt; the provider decides what skipping means. */
  const skip = () => {
    if (!prompt || sending) return
    setSending(true)
    void client
      .command(Cmd.AuthLoginPrompt, { promptId: prompt.promptId, cancel: true })
      .finally(() => setSending(false))
  }

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
          <button
            onClick={() => void client.command(Cmd.AuthLoginCancel, { loginId: flow.loginId })}
            className="text-[11px] text-dim hover:text-danger transition-colors"
          >
            cancel
          </button>
        )}
      </div>

      {flow.steps.length > 0 && (
        <div className="space-y-1.5">
          {flow.steps.map((ev, i) => (
            <LoginStepLine key={i} ev={ev} />
          ))}
        </div>
      )}

      {prompt && !terminal && (
        <LoginPromptForm
          prompt={prompt}
          value={answer}
          setValue={setAnswer}
          sending={sending}
          error={error}
          onSubmit={submit}
          onSkip={skip}
        />
      )}

      {flow.result !== null && (
        <LoginOutcome
          result={flow.result}
          provider={flow.provider}
          message={flow.message}
          onDone={onDone}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      )}
    </section>
  )
}
