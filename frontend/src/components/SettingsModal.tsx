import { useEffect, useRef, useState } from 'react'
import { BackendClient } from '../backend'
import { Cmd, type ConfigProblem, type SettingsValidateResult } from '../protocol'
import { store, useUIState } from '../store'

const VALIDATE_DEBOUNCE_MS = 350

/**
 * Settings modal: raw settings.yaml editor with live backend validation.
 * Errors block saving (Save disabled + save round-trip re-validates);
 * warnings are shown but allow saving.
 */
export function SettingsModal({ client }: { client: BackendClient }) {
  const open = useUIState((s) => s.settingsOpen)

  const [yaml, setYaml] = useState('')
  const [problems, setProblems] = useState<ConfigProblem[]>([])
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Monotonic token so stale validate responses never overwrite newer ones.
  const validateSeq = useRef(0)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runValidation = (text: string) => {
    const seq = ++validateSeq.current
    setValidating(true)
    void client
      .command<SettingsValidateResult>(Cmd.SettingsValidate, { yaml: text })
      .then((resp) => {
        if (seq !== validateSeq.current) return
        if (resp.ok && resp.payload) {
          setProblems(resp.payload.problems ?? [])
        } else {
          setProblems([{ severity: 'error', message: resp.error?.message ?? 'validation failed' }])
        }
      })
      .catch((err) => {
        if (seq !== validateSeq.current) return
        setProblems([{ severity: 'error', message: String(err) }])
      })
      .finally(() => {
        if (seq === validateSeq.current) setValidating(false)
      })
  }

  // Load current YAML each time the modal opens.
  useEffect(() => {
    if (!open) return
    setSaveError(null)
    void client.command<{ yaml: string }>(Cmd.SettingsGet, {}).then((resp) => {
      const text = resp.ok && resp.payload ? resp.payload.yaml : '# failed to load settings\n'
      setYaml(text)
      runValidation(text)
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

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
  }, [])

  if (!open) return null

  const onChange = (text: string) => {
    setYaml(text)
    setSaveError(null)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => runValidation(text), VALIDATE_DEBOUNCE_MS)
  }

  const hasErrors = problems.some((p) => p.severity === 'error')
  const close = () => store.setSettingsOpen(false)

  const save = async () => {
    if (hasErrors || validating || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const resp = await client.command<SettingsValidateResult>(Cmd.SettingsSave, { yaml })
      if (!resp.ok) {
        // Backend re-validates authoritatively; surface its problems.
        const serverProblems = resp.payload?.problems
        if (serverProblems?.length) setProblems(serverProblems)
        setSaveError(resp.error?.message ?? 'save failed')
        return
      }
      close()
    } catch (err) {
      setSaveError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-base/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="no-drag w-full max-w-2xl rounded-xl border border-line bg-surface shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 shrink-0">
          <span className="text-xs font-mono text-mute">settings.yaml</span>
          <div className="flex items-center gap-2">
            {validating && <span className="text-[10px] text-dim">validating…</span>}
            <button aria-label="Close settings" onClick={close} className="text-dim hover:text-ink transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <textarea
          value={yaml}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          aria-label="Settings YAML"
          className="flex-1 min-h-72 bg-base px-4 py-3 text-ink font-mono text-xs leading-relaxed outline-none resize-none"
        />

        {(problems.length > 0 || saveError) && (
          <div className="border-t border-line px-4 py-2 max-h-36 overflow-y-auto shrink-0">
            {saveError && (
              <div className="flex gap-2 py-0.5 text-xs">
                <span className="text-danger shrink-0">✕</span>
                <span className="text-danger">{saveError}</span>
              </div>
            )}
            {problems.map((p, i) => (
              <div key={i} className="flex gap-2 py-0.5 text-xs">
                <span className={`shrink-0 ${p.severity === 'error' ? 'text-danger' : 'text-warn'}`}>
                  {p.severity === 'error' ? '✕' : '⚠'}
                </span>
                <span className={p.severity === 'error' ? 'text-danger' : 'text-warn/80'}>{p.message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line px-4 py-2.5 shrink-0">
          <span className="text-[10px] text-faint">
            saving restarts the agent with the new config
          </span>
          <div className="flex gap-2">
            <button
              onClick={close}
              className="px-3 py-1.5 rounded-lg text-xs text-mute hover:text-ink hover:bg-surface2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={hasErrors || validating || saving}
              title={hasErrors ? 'Fix the errors above to save' : undefined}
              className="px-3 py-1.5 rounded-lg text-xs bg-accent hover:bg-accenthover disabled:opacity-50 disabled:cursor-not-allowed text-onaccent transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
