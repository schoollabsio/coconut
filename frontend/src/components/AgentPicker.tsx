import { useEffect, useState } from 'react'
import { BackendClient } from '../backend'
import { relativeTime, formatBytes } from '../format'
import { Cmd, type AgentPromptResult } from '../protocol'
import { store, useUIState } from '../store'

/** Agent/session picker: shown after opening a workspace that has agents,
 *  and on demand from the header. Picking sends agent.open; the backend
 *  restarts the sidecar around the choice. */
export function AgentPicker({ client }: { client: BackendClient }) {
  const open = useUIState((s) => s.agentPickerOpen)
  const agents = useUIState((s) => s.agentList)
  const currentSlug = useUIState((s) => s.agentSlug)
  const workspacePath = useUIState((s) => s.workspace?.path ?? '')
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  // Custom system prompt editing (for the selected agent).
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [promptSaved, setPromptSaved] = useState('')
  const [promptLoaded, setPromptLoaded] = useState(false)

  const selectedSlugEff = agents.find((a) => a.slug === selectedSlug)?.slug ?? agents[0]?.slug ?? null

  // Lazy-load the selected agent's prompt when the section is expanded.
  useEffect(() => {
    if (!open || !promptOpen || !selectedSlugEff) return
    let cancelled = false
    setPromptLoaded(false)
    void client.command<AgentPromptResult>(Cmd.AgentPromptGet, { slug: selectedSlugEff }).then((resp) => {
      if (cancelled) return
      if (resp.ok) {
        const text = resp.payload?.prompt ?? ''
        setPromptDraft(text)
        setPromptSaved(text)
      } else {
        store.pushNotification('error', resp.error?.message ?? 'failed to load system prompt')
      }
      setPromptLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [open, promptOpen, selectedSlugEff, client])

  if (!open) return null

  const selected = agents.find((a) => a.slug === selectedSlug) ?? agents[0] ?? null

  const openAgent = async (payload: Record<string, unknown>) => {
    setBusy(true)
    try {
      const resp = await client.command(Cmd.AgentOpen, payload)
      if (resp.ok) {
        store.closeAgentPicker()
      } else {
        store.pushNotification('error', resp.error?.message ?? 'failed to open agent')
      }
    } finally {
      setBusy(false)
    }
  }

  const createAgent = () => {
    const name = newName.trim()
    if (!name) return
    setNewName('')
    void openAgent({ name, new: true })
  }

  const openInNewWindow = async (a: { slug: string; name: string }) => {
    if (!workspacePath) return
    try {
      const resp = await client.command(Cmd.WindowNew, {
        workspace: workspacePath,
        agentSlug: a.slug,
        agentName: a.name,
      })
      if (!resp.ok) {
        store.pushNotification('error', resp.error?.message ?? 'failed to open new window')
      }
    } catch {
      store.pushNotification('error', 'failed to open new window')
    }
  }

  const savePrompt = async (text: string) => {
    if (!selectedSlugEff) return
    setBusy(true)
    try {
      const resp = await client.command<AgentPromptResult>(Cmd.AgentPromptSet, { slug: selectedSlugEff, prompt: text })
      if (resp.ok) {
        const saved = resp.payload?.prompt ?? ''
        setPromptDraft(saved)
        setPromptSaved(saved)
        store.setAgentHasPrompt(selectedSlugEff, saved !== '')
        store.pushNotification('info', saved ? 'System prompt saved — applies to the next message' : 'System prompt cleared')
      } else {
        store.pushNotification('error', resp.error?.message ?? 'failed to save system prompt')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-base/70"
      onClick={() => store.closeAgentPicker()}
    >
      <div
        className="no-drag w-[680px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-linestrong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-medium text-ink">Agents &amp; sessions</h2>
          <button
            aria-label="Close"
            onClick={() => store.closeAgentPicker()}
            className="p-1 rounded-md text-dim hover:text-ink hover:bg-surface2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[220px_1fr]">
          {/* Agents */}
          <div className="border-r border-line overflow-y-auto">
            {agents.map((a) => (
              <div
                key={a.slug}
                onClick={() => setSelectedSlug(a.slug)}
                className={`w-full text-left px-3 py-2 border-b border-line/60 transition-colors cursor-pointer ${
                  selected?.slug === a.slug ? 'bg-surface2' : 'hover:bg-surface2/50'
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

          {/* Sessions for the selected agent */}
          <div className="overflow-y-auto">
            {selected && (
              <>
                <div className="border-b border-line">
                  <button
                    onClick={() => setPromptOpen((v) => !v)}
                    aria-expanded={promptOpen}
                    className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-mute hover:text-ink transition-colors"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${promptOpen ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    System prompt
                    {selected.hasSystemPrompt && (
                      <span title="This agent has custom instructions" className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    )}
                  </button>
                  {promptOpen && (
                    <div className="px-3 pb-3">
                      <textarea
                        value={promptDraft}
                        onChange={(e) => setPromptDraft(e.target.value)}
                        placeholder={promptLoaded ? 'Custom instructions for this agent (optional)…' : 'Loading…'}
                        disabled={!promptLoaded || busy}
                        rows={5}
                        spellCheck={false}
                        aria-label="Custom system prompt"
                        className="w-full bg-surface2 text-xs text-ink rounded-md px-2 py-1.5 border border-linestrong focus:border-linestrong outline-none resize-y font-mono"
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          onClick={() => void savePrompt(promptDraft)}
                          disabled={busy || !promptLoaded || promptDraft.trim() === promptSaved}
                          className="text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
                        >
                          Save
                        </button>
                        {promptSaved !== '' && (
                          <button
                            onClick={() => void savePrompt('')}
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
                <div className="sticky top-0 bg-surface px-3 py-2 border-b border-line">
                  <button
                    onClick={() => void openAgent({ slug: selected.slug, new: true })}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
                  >
                    + New session
                  </button>
                  {selected.sessions.some((s) => s.current) && (
                    <button
                      onClick={() =>
                        void openAgent({ slug: selected.slug, sessionFile: selected.sessions.find((s) => s.current)!.file })
                      }
                      disabled={busy}
                      className="ml-2 text-xs px-2 py-1 rounded-md bg-surface2 text-ink hover:bg-raised disabled:opacity-40"
                    >
                      Resume latest
                    </button>
                  )}
                </div>
                {selected.sessions.length === 0 && (
                  <p className="px-3 py-4 text-xs text-dim">No sessions yet for this agent.</p>
                )}
                {selected.sessions.map((s) => (
                  <button
                    key={s.file}
                    onClick={() => void openAgent({ slug: selected.slug, sessionFile: s.file })}
                    disabled={busy}
                    className="w-full text-left px-3 py-2 border-b border-line/60 hover:bg-surface2/50 transition-colors disabled:opacity-40"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs text-mute">{relativeTime(s.startedAt)}</span>
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
        </div>
      </div>
    </div>
  )
}
