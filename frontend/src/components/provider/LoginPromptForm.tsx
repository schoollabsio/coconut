import type { AuthPrompt } from '../../protocol'

/**
 * The answer form for a login prompt the helper is waiting on: a select for
 * `select`, otherwise a text/secret input (Enter submits). Controlled — the flow
 * card owns the draft, the busy flag and the send error, because cancelling the
 * whole login has to be able to interrupt a send.
 */
export function LoginPromptForm({
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
  const question = prompt.prompt.message ?? prompt.prompt.label
  return (
    <div className="space-y-2 pt-1 border-t border-line/60">
      {question && <p className="text-[11px] text-mute">{question}</p>}
      {prompt.prompt.type === 'select' ? (
        <SelectAnswer prompt={prompt.prompt} value={value} setValue={setValue} />
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

function SelectAnswer({
  prompt,
  value,
  setValue,
}: {
  prompt: AuthPrompt
  value: string
  setValue: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="w-full appearance-none rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none focus:border-accent/60"
    >
      <option value="">choose…</option>
      {(prompt.options ?? []).map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
