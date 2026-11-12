import { useEffect, useState } from 'react'
import { BackendClient } from '../backend'
import { store, useUIState } from '../store'
import { AdvancedPanel } from './AdvancedPanel'
import { ProviderPanel } from './provider/ProviderPanel'

type Panel = 'provider' | 'advanced'

/**
 * Settings modal: sidebar layout (not tabs).
 *   Provider — structured provider/model/auth UI (default)
 *   Advanced — the raw settings.yaml editor with live validation
 */
export function SettingsModal({ client }: { client: BackendClient }) {
  const open = useUIState((s) => s.settingsOpen)
  const [panel, setPanel] = useState<Panel>('provider')

  // Default back to the Provider panel each time the modal opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPanel('provider')
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) store.setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const close = () => store.setSettingsOpen(false)

  const navBtn = (id: Panel, label: string) => (
    <button
      onClick={() => setPanel(id)}
      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
        panel === id ? 'bg-surface2 text-ink' : 'text-mute hover:text-ink hover:bg-surface2/60'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-base/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="no-drag w-full max-w-3xl h-[80vh] rounded-xl border border-line bg-surface shadow-2xl overflow-hidden flex">
        {/* Sidebar */}
        <div className="w-40 shrink-0 border-r border-line bg-base/40 p-2 flex flex-col gap-1">
          <div className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-faint">settings</div>
          {navBtn('provider', 'Provider')}
          {navBtn('advanced', 'Advanced')}
          <div className="mt-auto px-2 py-1.5 text-[10px] leading-relaxed text-faint">
            credentials live in pi's credential store, not this app
          </div>
        </div>

        {/* Panel */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex items-center justify-end px-3 py-1.5 border-b border-line/60 shrink-0">
            <button aria-label="Close settings" onClick={close} className="text-dim hover:text-ink transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {panel === 'provider' ? (
              <ProviderPanel client={client} />
            ) : (
              <AdvancedPanel client={client} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
