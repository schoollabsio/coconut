import { useState } from 'react'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { store, useUIState } from '../store'

/** Agent/session picker: shown after opening a workspace that has agents,
 *  and on demand from the header. Picking sends agent.open; the backend
 *  restarts the sidecar around the choice. */
export function AgentPicker({ client }: { client: BackendClient }) {
  const open = useUIState((s) => s.agentPickerOpen)
  const agents = useUIState((s) => s.agentList)
  const currentSlug = useUIState((s) => s.agentSlug)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

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

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={() => store.closeAgentPicker()}
    >
      <div
        className="no-drag w-[680px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-200">Agents &amp; sessions</h2>
          <button
            aria-label="Close"
            onClick={() => store.closeAgentPicker()}
            className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[220px_1fr]">
          {/* Agents */}
          <div className="border-r border-gray-800 overflow-y-auto">
            {agents.map((a) => (
              <button
                key={a.slug}
                onClick={() => setSelectedSlug(a.slug)}
                className={`w-full text-left px-3 py-2 border-b border-gray-800/60 transition-colors ${
                  selected?.slug === a.slug ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-gray-200 truncate">{a.name}</span>
                  {a.slug === currentSlug && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-400">open</span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500 font-mono truncate">{a.slug}</div>
              </button>
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
                className="w-full bg-gray-800 text-sm text-gray-200 rounded-md px-2 py-1 border border-gray-700 focus:border-gray-500 outline-none"
              />
              <button
                onClick={createAgent}
                disabled={!newName.trim() || busy}
                className="mt-1.5 w-full text-xs px-2 py-1 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
              >
                + New agent
              </button>
            </div>
          </div>

          {/* Sessions for the selected agent */}
          <div className="overflow-y-auto">
            {selected && (
              <>
                <div className="sticky top-0 bg-gray-900 px-3 py-2 border-b border-gray-800">
                  <button
                    onClick={() => void openAgent({ slug: selected.slug, new: true })}
                    disabled={busy}
                    className="text-xs px-2 py-1 rounded-md bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
                  >
                    + New session
                  </button>
                  {selected.sessions.some((s) => s.current) && (
                    <button
                      onClick={() =>
                        void openAgent({ slug: selected.slug, sessionFile: selected.sessions.find((s) => s.current)!.file })
                      }
                      disabled={busy}
                      className="ml-2 text-xs px-2 py-1 rounded-md bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
                    >
                      Resume latest
                    </button>
                  )}
                </div>
                {selected.sessions.length === 0 && (
                  <p className="px-3 py-4 text-xs text-gray-500">No sessions yet for this agent.</p>
                )}
                {selected.sessions.map((s) => (
                  <button
                    key={s.file}
                    onClick={() => void openAgent({ slug: selected.slug, sessionFile: s.file })}
                    disabled={busy}
                    className="w-full text-left px-3 py-2 border-b border-gray-800/60 hover:bg-gray-800/50 transition-colors disabled:opacity-40"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs text-gray-300">{relativeTime(s.startedAt)}</span>
                      {s.current && (
                        <span className="text-[10px] uppercase tracking-wide text-emerald-400">current</span>
                      )}
                      <span className="ml-auto text-[10px] text-gray-600 font-mono">{formatBytes(s.sizeBytes)}</span>
                    </div>
                    {s.preview && <div className="mt-0.5 text-xs text-gray-500 truncate">{s.preview}</div>}
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

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const delta = Date.now() - t
  const min = Math.floor(delta / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
