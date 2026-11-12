/**

/**
 * The per-agent system prompt editor in the picker's right column. Custom
 * instructions apply to the agent's next message (no sidecar restart), so this
 * saves straight through `agent.prompt` rather than via settings.
 */
export default function SystemPromptSection({
  hasCustom,
  open,
  onToggle,
  draft,
  setDraft,
  busy,
  saved,
  loaded,
  save,
}: {
  hasCustom: boolean
  open: boolean
  onToggle: () => void
  draft: string
  setDraft: (v: string) => void
  busy: boolean
  saved: string
  /** The draft has been fetched for this agent; until then it is not editable. */
  loaded: boolean
  save: (text: string) => Promise<void>
}) {
  const canSave = !busy && loaded && draft.trim() !== saved
  return (
    <div className="border-b border-line">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-mute hover:text-ink transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        System prompt
        {hasCustom && (
          <span title="This agent has custom instructions" className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={loaded ? 'Custom instructions for this agent (optional)…' : 'Loading…'}
            disabled={!loaded || busy}
            rows={5}
            spellCheck={false}
            aria-label="Custom system prompt"
            className="w-full bg-surface2 text-xs text-ink rounded-md px-2 py-1.5 border border-linestrong focus:border-linestrong outline-none resize-y font-mono"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={() => void save(draft)}
              disabled={!canSave}
              className="text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
            >
              Save
            </button>
            {saved !== '' && (
              <button
                onClick={() => void save('')}
                disabled={busy}
                className="text-xs px-2 py-1 rounded-md bg-surface2 text-mute hover:bg-raised disabled:opacity-40"
              >
                Clear
              </button>
            )}
            <span className="text-[10px] text-faint">applies to this agent's next message — no restart needed</span>
          </div>
        </div>
      )}
    </div>
  )
}
