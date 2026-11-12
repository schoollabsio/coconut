import { useEffect, useState } from 'react'
import { BackendClient } from '../../backend'
import { Cmd, type AgentPromptResult, type AgentSummary } from '../../protocol'
import { store, useUIState, type UIState } from '../../store'
import AgentList from './AgentList'
import SessionList from './SessionList'

/** Agent/session picker: shown after opening a workspace that has agents,
 *  and on demand from the header. Picking sends agent.open; the backend
 *  restarts the sidecar around the choice. */
export function AgentPicker({ client }: { client: BackendClient }) {
  const open = useUIState<boolean>((s: UIState) => s.agentPickerOpen)
  const agents = useUIState<AgentSummary[]>((s: UIState) => s.agentList)
  const currentSlug = useUIState<string>((s: UIState) => s.agentSlug)
  const workspacePath = useUIState<string | null>((s: UIState) => s.workspace?.path ?? '')
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
          <AgentList
            agents={agents}
            selectedSlug={selectedSlug}
            setSelectedSlug={setSelectedSlug}
            newName={newName}
            setNewName={setNewName}
            busy={busy}
            createAgent={createAgent}
            openInNewWindow={openInNewWindow}
            currentSlug={currentSlug}
          />
          {/* Sessions for the selected agent */}
          <SessionList
            selected={selected}
            busy={busy}
            openAgent={openAgent}
            promptOpen={promptOpen}
            setPromptOpen={setPromptOpen}
            promptDraft={promptDraft}
            setPromptDraft={setPromptDraft}
            promptSaved={promptSaved}
            promptLoaded={promptLoaded}
            savePrompt={savePrompt}
          />
        </div>
      </div>
    </div>
  )
}