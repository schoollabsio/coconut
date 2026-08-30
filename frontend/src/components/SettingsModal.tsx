import { useEffect, useState } from 'react'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { store, useUIState } from '../store'

const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'mistral', 'xai']

/**
 * Settings modal. The mockup edited raw settings.yaml; the real app owns
 * concrete settings (provider, API key, model, bash whitelist), so this
 * is a small form backed by settings.get / settings.save.
 */
export function SettingsModal({ client }: { client: BackendClient }) {
  const open = useUIState((s) => s.settingsOpen)
  const settings = useUIState((s) => s.settings)

  const [provider, setProvider] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [model, setModel] = useState('')
  const [whitelist, setWhitelist] = useState('')
  const [saving, setSaving] = useState(false)

  // Refresh from the backend each time the modal opens.
  useEffect(() => {
    if (!open) return
    void client.command(Cmd.SettingsGet, {}).then((resp) => {
      const s = (resp.ok && resp.payload ? resp.payload : settings) as typeof settings
      if (!s) return
      setProvider(s.provider || 'anthropic')
      setModel(s.model ?? '')
      setWhitelist((s.bashWhitelist ?? []).join('\n'))
      setApiKey('')
      setClearKey(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const save = async () => {
    setSaving(true)
    try {
      await client.command(Cmd.SettingsSave, {
        provider,
        apiKey: apiKey || undefined,
        clearApiKey: clearKey,
        model: model || undefined,
        bashWhitelist: whitelist
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      })
      close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5">
          <span className="text-xs font-mono text-gray-400">settings</span>
          <button aria-label="Close settings" onClick={close} className="text-gray-500 hover:text-gray-200 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 text-sm">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-gray-400">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-gray-200 outline-none focus:border-gray-600"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-gray-400">
              API key{' '}
              {settings?.apiKeyConfigured && !clearKey && (
                <span className="text-emerald-400/80">(a key is saved — leave blank to keep it)</span>
              )}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                if (e.target.value) setClearKey(false)
              }}
              placeholder={settings?.apiKeyConfigured ? '••••••••' : 'paste your provider API key'}
              spellCheck={false}
              className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-gray-200 outline-none focus:border-gray-600 font-mono text-xs"
            />
            {settings?.apiKeyConfigured && (
              <label className="flex items-center gap-1.5 text-xs text-gray-500">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
                remove the saved key
              </label>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-gray-400">Model (optional — pi pattern or ID)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-5 or openai/gpt-5:high"
              spellCheck={false}
              className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-gray-200 outline-none focus:border-gray-600 font-mono text-xs"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-gray-400">
              Bash whitelist <span className="text-gray-600">— one command prefix per line; anything else needs approval</span>
            </span>
            <textarea
              value={whitelist}
              onChange={(e) => setWhitelist(e.target.value)}
              rows={6}
              spellCheck={false}
              className="bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-gray-200 outline-none focus:border-gray-600 font-mono text-xs leading-relaxed resize-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-800 px-4 py-2.5">
          <button
            onClick={close}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-xs bg-blue-500 hover:bg-blue-400 disabled:opacity-50 text-white transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
