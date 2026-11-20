import { useEffect, useMemo } from 'react'
import { BackendClient, BackendUnavailableError } from './backend'
import { Cmd, type BackendMessage } from './protocol'
import { pickApprovalToRespond, respondToApproval } from './approvalActions'
import { refreshClock } from './approvalClock'
import { store, useUIState } from './store'
import { Chat } from './components/Chat'
import { ColumnGrid } from './components/ColumnGrid'
import { ContentPanel } from './components/ContentPanel'
import { Header } from './components/Header'
import { SettingsModal } from './components/SettingsModal'
import { AgentPicker } from './components/AgentPicker'

export default function App() {
  const client = useMemo(() => new BackendClient(), [])
  const needsWorkspace = useUIState((s) => s.needsWorkspace)
  const notifications = useUIState((s) => s.notifications)
  const connected = useUIState((s) => s.connected)
  const pendingApprovals = useUIState((s) => s.pendingApprovals)
  const focusedApprovalId = useUIState((s) => s.focusedApprovalId)

  // NOTE: no "booted" ref guard — React StrictMode (dev) intentionally
  // mounts, cleans up, and re-mounts effects. A ref guard would skip the
  // second subscription, leaving the app deaf to all backend events.
  // Cleanup must fully undo setup; setup must be safe to run twice.
  useEffect(() => {
    // TEMP (flicker diagnosis): report UI lifecycle to the backend log.
    const diag = (kind: string, detail?: string) => {
      client.command(Cmd.Diagnostics, { kind, detail: detail ?? '' }).catch(() => {})
    }
    diag('page.load', window.location.href)

    // Buffer events until the initial snapshot lands, then flush in
    // order (Appendix A: connect → snapshot → live events).
    let gotSnapshot = false
    let cancelled = false
    type Buffered = { msg: BackendMessage; sender?: string }
    const buffered: Buffered[] = []
    let resyncing = false

    const resync = async () => {
      if (resyncing) return
      resyncing = true
      diag('store.resync', `lastSeq=${store.state.lastBackendSeq}`)
      try {
        const snap = await client.requestSnapshot()
        if (!cancelled) {
          store.applyBackendMessage(snap)
          diag('store.snapshot', `seq=${(snap as { seq?: number }).seq ?? '?'}`)
        }
      } finally {
        resyncing = false
      }
    }
    store.resync = () => void resync()

    // The auto-approve timer needs the same transport a click uses. Injected
    // rather than imported so the store stays free of the Wails bindings. The
    // client is stateless, so a remount replacing it is harmless — no cleanup
    // needed (and nulling it here would strand any clock fired mid-remount).
    store.respondApproval = (approvalId, decision) =>
      respondToApproval(client, approvalId, decision)

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = client.onMessage((msg, sender) => {
        if (cancelled) return
        if (!gotSnapshot) {
          buffered.push({ msg, sender })
          return
        }
        store.applyBackendMessage(msg, sender)
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
        if (cancelled) return
        if (resp.ok && resp.payload?.needsWorkspace) {
          store.setNeedsWorkspace(true)
        }
        const snap = await client.requestSnapshot()
        if (cancelled) return
        store.applyBackendMessage(snap)
        gotSnapshot = true
        for (const { msg, sender } of buffered) store.applyBackendMessage(msg, sender)
      } catch (err) {
        if (!cancelled) console.error('boot failed', err)
      }
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [client])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'Enter' && e.key !== 'NumpadEnter') return
      const approval = pickApprovalToRespond(pendingApprovals, focusedApprovalId)
      if (!approval) return
      e.preventDefault()
      void client.command(Cmd.ApprovalRespond, { approvalId: approval.id, decision: 'allow' })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [client, focusedApprovalId, pendingApprovals])

  // A hidden or occluded window throttles timers: the countdown ticker stops and
  // a deadline can be slept clean through. Coming back, re-read the wall clock
  // and fire whatever is already overdue, so no card is left frozen at "3s" over
  // a decision that fell due minutes ago.
  useEffect(() => {
    const onReturn = () => {
      refreshClock()
      store.sweepApprovalClocks()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onReturn()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    // Content fills the whole window (hidden titlebar). The root is the
    // window drag region; interactive containers opt back out (no-drag).
    <div className="drag-region h-full flex flex-col">
      <Header client={client} />

      {needsWorkspace ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="no-drag border border-dashed border-linestrong rounded-lg px-10 py-12 text-center">
            <div className="text-mute text-sm font-medium">Choose a workspace to begin</div>
            <div className="text-dim text-xs mt-1 mb-4">The agent reads and proposes changes inside this folder.</div>
            <button
              onClick={() => void client.command(Cmd.WorkspacePick, {})}
              className="px-4 py-2 rounded-lg text-sm bg-accent hover:bg-accenthover text-onaccent transition-colors"
            >
              Choose folder…
            </button>
          </div>
        </div>
      ) : (
        <ColumnGrid chat={<Chat client={client} />} content={<ContentPanel client={client} />} />
      )}

      <SettingsModal client={client} />
      <AgentPicker client={client} />

      {/* Notifications */}
      <div className="no-drag fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm">
        {notifications.map((n) => (
          <button
            key={n.id}
            onClick={() => store.dismissNotification(n.id)}
            className={`text-left text-xs rounded-lg border px-3 py-2 shadow-lg backdrop-blur transition-colors ${
              n.level === 'error'
                ? 'border-danger/40 bg-danger/15 text-danger'
                : n.level === 'warning'
                  ? 'border-warn/40 bg-warn/15 text-warn'
                  : 'border-linestrong bg-surface/80 text-mute'
            }`}
          >
            {n.message}
          </button>
        ))}
      </div>

      {!connected && !needsWorkspace && (
        <div className="fixed inset-x-0 top-0 z-30 text-center text-[11px] text-dim bg-base/80 py-0.5">
          connecting…
        </div>
      )}
    </div>
  )
}
