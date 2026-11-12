import type { AgentSummary } from '../../protocol'

interface AgentListProps {
  agents: AgentSummary[]
  selectedSlug: string | null
  setSelectedSlug: (slug: string | null) => void
  newName: string
  setNewName: (name: string) => void
  busy: boolean
  createAgent: () => void
  openInNewWindow: (agent: { slug: string; name: string }) => void
  currentSlug: string | null
}

export default function AgentList({
  agents,
  selectedSlug,
  setSelectedSlug,
  newName,
  setNewName,
  busy,
  createAgent,
  openInNewWindow,
  currentSlug,
}: AgentListProps) {
  return (
    <div className="border-r border-line overflow-y-auto">
      {agents.map((a) => (
        <div
          key={a.slug}
          onClick={() => setSelectedSlug(a.slug)}
          className={`w-full text-left px-3 py-2 border-b border-line/60 transition-colors cursor-pointer ${
            selectedSlug === a.slug ? 'bg-surface2' : 'hover:bg-surface2/50'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-ink truncate">{a.name}</span>
            {a.slug === currentSlug && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-ok">open</span>
            )}
            {a.hasSystemPrompt && (
              <span title="Has a custom system prompt" className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent" />
            )}
            <button
              aria-label={`Open ${a.name} in a new window`}
              title="Open in new window"
              onClick={(e) => {
                e.stopPropagation()
                void openInNewWindow(a)
              }}
              className="ml-auto shrink-0 p-1 rounded-md text-dim hover:text-ink hover:bg-raised"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 5H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-5M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          </div>
          <div className="text-[11px] text-dim font-mono truncate">{a.slug}</div>
        </div>
      ))}
      <div className="p-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') createAgent()
          }}
          placeholder="New agent name…"
          spellCheck={false}
          className="w-full bg-surface2 text-sm text-ink rounded-md px-2 py-1 border border-linestrong focus:border-linestrong outline-none"
        />
        <button
          onClick={createAgent}
          disabled={!newName.trim() || busy}
          className="mt-1.5 w-full text-xs px-2 py-1 rounded-md bg-surface2 text-mute hover:bg-raised disabled:opacity-40"
        >
          + New agent
        </button>
      </div>
    </div>
  )
}
