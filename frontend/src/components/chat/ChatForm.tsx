import { useRef, useEffect } from 'react'

/** Input grows with the draft up to this height, then scrolls. */
const MAX_INPUT_HEIGHT = 160

interface ChatFormProps {
  draft: string
  setDraft: React.Dispatch<React.SetStateAction<string>>
  busy: boolean
  onSend: () => Promise<void>
  onCancel: () => void
}

/**
 * The composer: a rounded pill holding the textarea and a single round button —
 * Send while idle, Stop while a run is busy. Enter sends, Shift+Enter inserts a
 * newline. Empty drafts are rejected by the caller's send(); the textarea grows
 * with the draft up to MAX_INPUT_HEIGHT and collapses again when a send clears it.
 */
export function ChatForm({ draft, setDraft, busy, onSend, onCancel }: ChatFormProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const autoresize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px'
  }

  // Runs on every draft change, so clearing the draft on send collapses the box.
  useEffect(() => {
    autoresize()
  }, [draft])

  return (
    <form
      className="mt-3 flex items-center gap-2 rounded-3xl bg-surface2 px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        void onSend()
      }}
    >
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        placeholder="Ask a follow-up…"
        aria-label="Message the agent"
        onChange={(e) => {
          setDraft(e.target.value)
          autoresize()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void onSend()
          }
        }}
        className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-base leading-loose text-ink outline-none placeholder-faint"
      />
      {busy ? (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Stop the agent"
          title="Stop the agent"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised text-mute transition-colors hover:bg-danger/80 hover:text-onaccent"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send message"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-onaccent transition-colors hover:bg-accenthover"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m-7 7l7-7 7 7" />
          </svg>
        </button>
      )}
    </form>
  )
}
