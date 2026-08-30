import { useEffect, useMemo, useRef } from 'react'
import { BackendClient, BackendUnavailableError } from './backend'
import { Cmd, type BackendMessage } from './protocol'
import { store, useUIState } from './store'
import { Chat } from './components/Chat'
import { ColumnGrid } from './components/ColumnGrid'
import { ContentPanel } from './components/ContentPanel'
import { Header } from './components/Header'
import { SettingsModal } from './components/SettingsModal'
import { ToolLog } from './components/ToolLog'

export default function App() {
  const client = useMemo(() => new BackendClient(), [])
  const needsWorkspace = useUIState((s) => s.needsWorkspace)
  const notifications = useUIState((s) => s.notifications)
  const connected = useUIState((s) => s.connected)

  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true

    // Buffer events until the initial snapshot lands, then flush in
    // order (Appendix A: connect → snapshot → live events).
    let gotSnapshot = false
    const buffered: BackendMessage[] = []
    let resyncing = false

    const resync = async () => {
      if (resyncing) return
      resyncing = true
      try {
        const snap = await client.requestSnapshot()
        store.applyBackendMessage(snap)
      } finally {
        resyncing = false
      }
    }
    store.resync = () => void resync()

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = client.onMessage((msg) => {
        if (!gotSnapshot) {
          buffered.push(msg)
          return
        }
        store.applyBackendMessage(msg)
      })
    } catch (err) {
      if (err instanceof BackendUnavailableError) {
        console.warn(err.message)
        return
      }
      throw err
    }

    void (async () => {
      try {
        const resp = await client.command<{ needsWorkspace?: boolean }>(Cmd.SessionRestore, {})
        if (resp.ok && resp.payload?.needsWorkspace) {
          store.setNeedsWorkspace(true)
        }
        const snap = await client.requestSnapshot()
        store.applyBackendMessage(snap)
        gotSnapshot = true
        for (const m of buffered) store.applyBackendMessage(m)
      } catch (err) {
        console.error('boot failed', err)
      }
    })()

    return () => unsubscribe?.()
  }, [client])

  return (
    <div className="h-full flex items-center justify-center p-2">
      <div className="bg-gray-900 rounded-2xl shadow-2xl p-2 w-full max-w-[1400px] h-full max-h-[900px] border border-gray-800 flex flex-col">
        <Header client={client} />

        {needsWorkspace ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="border border-dashed border-gray-700 rounded-lg px-10 py-12 text-center">
              <div className="text-gray-300 text-sm font-medium">Choose a workspace to begin</div>
              <div className="text-gray-500 text-xs mt-1 mb-4">The agent reads and proposes changes inside this folder.</div>
              <button
                onClick={() => void client.command(Cmd.WorkspacePick, {})}
                className="px-4 py-2 rounded-lg text-sm bg-blue-500 hover:bg-blue-400 text-white transition-colors"
              >
                Choose folder…
              </button>
            </div>
          </div>
        ) : (
          <ColumnGrid
            tools={<ToolLog />}
            chat={<Chat client={client} />}
            content={<ContentPanel client={client} />}
          />
        )}
      </div>

      <SettingsModal client={client} />

      {/* Notifications */}
      <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm">
        {notifications.map((n) => (
          <button
            key={n.id}
            onClick={() => store.dismissNotification(n.id)}
            className={`text-left text-xs rounded-lg border px-3 py-2 shadow-lg backdrop-blur transition-colors ${
              n.level === 'error'
                ? 'border-red-500/40 bg-red-950/80 text-red-200'
                : n.level === 'warning'
                  ? 'border-yellow-500/40 bg-yellow-950/80 text-yellow-200'
                  : 'border-gray-700 bg-gray-900/80 text-gray-300'
            }`}
          >
            {n.message}
          </button>
        ))}
      </div>

      {!connected && !needsWorkspace && (
        <div className="fixed inset-x-0 top-0 z-30 text-center text-[11px] text-gray-500 bg-gray-950/80 py-0.5">
          connecting…
        </div>
      )}
    </div>
  )
}
