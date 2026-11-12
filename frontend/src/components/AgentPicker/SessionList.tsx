import type { AgentSummary, SessionSummary } from '../../protocol'
import { relativeTime, formatBytes } from '../../format'
import SystemPromptSection from './SystemPromptSection'

interface SessionListProps {
  selected: AgentSummary | null
  busy: boolean
  openAgent: (payload: Record<string, unknown>) => void
  promptOpen: boolean
  setPromptOpen: (open: boolean | ((prev: boolean) => boolean)) => void
  promptDraft: string
  setPromptDraft: (draft: string) => void
  promptSaved: string
  promptLoaded: boolean
  savePrompt: (text: string) => Promise<void>
}

export default function SessionList({
  selected,
  busy,
  openAgent,
  promptOpen,
  setPromptOpen,
  promptDraft,
  setPromptDraft,
  promptSaved,
  promptLoaded,
  savePrompt,
}: SessionListProps) {
  return (
    <div className="overflow-y-auto">
      {selected && (
        <>
          <SystemPromptSection
            hasCustom={!!selected.hasSystemPrompt}
            open={promptOpen}
            onToggle={() => setPromptOpen((v) => !v)}
            draft={promptDraft}
            setDraft={setPromptDraft}
            busy={busy}
            saved={promptSaved}
            loaded={promptLoaded}
            save={savePrompt}
          />
          <div className="sticky top-0 bg-surface px-3 py-2 border-b border-line">
            <button
              onClick={() => void openAgent({ slug: selected.slug, new: true })}
              disabled={busy}
              className="text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
            >
              + New session
            </button>
            {selected.sessions?.some((s: SessionSummary) => s.current) && (
              <button
                onClick={() =>
                  void openAgent({ slug: selected.slug, sessionFile: selected.sessions.find((s: SessionSummary) => s.current)!.file })}
                disabled={busy}
                className="ml-2 text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
              >
                Resume latest
              </button>
            )}
          </div>
          {selected.sessions?.length === 0 && (
            <p className="px-3 py-4 text-xs text-dim">No sessions yet for this agent.</p>
          )}
          {selected.sessions?.map((s: SessionSummary) => (
            <button
              key={s.file}
              onClick={() => void openAgent({ slug: selected.slug, sessionFile: s.file })}
              disabled={busy}
              className="w-full text-left px-3 py-2 border-b border-line/60 hover:bg-surface2/50 transition-colors disabled:opacity-40"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-mute">{relativeTime(s.startedAt)}
</span>
                {s.current && (
                  <span className="text-[10px] uppercase tracking-wide text-ok">current</span>
                )}
                <span className="ml-auto text-[10px] text-faint font-mono">{formatBytes(s.sizeBytes)}</span>
              </div>
              {s.preview && <div className="mt-0.5 text-xs text-dim truncate">{s.preview}</div>}
            </button>
          ))}
        </>
      )}
    </div>
  )
}