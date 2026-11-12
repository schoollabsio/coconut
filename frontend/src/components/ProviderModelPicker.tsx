import { useEffect, useState } from 'react'
import { BackendClient } from '../backend'
import {
  Cmd,
  type AuthModel,
  type AuthStatusResult,
  type SettingsValidateResult,
} from '../protocol'
import { store, useUIState } from '../store'
import { modelDisplayName, stripModelRef } from '../modelRef'
import { withProviderModel } from '../yamlPatch'
import { ModelMenu, ProviderMenu } from './provider/PickerMenu'
import { providerName } from './provider/pieces'

/**
 * Header chip: "<provider> / <model>" for the live session. Each half is a
 * quick picker — the provider half lists signed-in providers (switching
 * clears the model so the user re-picks for the new provider), the model
 * half lists the active provider's models. Both apply immediately via
 * settings.save (the sidecar restarts with the new selection) and track
 * the live session through auth.status, which useAuthStatus refreshes on
 * every settings.changed.
 */
export function ProviderModelPicker({ client, status }: { client: BackendClient; status: AuthStatusResult | null }) {
  const models = useUIState((s) => s.auth.models)
  const modelsFor = useUIState((s) => s.auth.modelsFor)
  const [open, setOpen] = useState<'none' | 'provider' | 'model'>('none')
  const [busy, setBusy] = useState(false)

  const { activeId, active, configured, activeModel } = activeSelection(status)
  const activeModels = modelsFor === activeId ? models : []

  // Warm the model cache for the active provider so the chip can show the
  // friendly model name and the popover opens with the list ready.
  useEffect(() => {
    if (!activeId || !configured || store.state.auth.modelsFor === activeId) return
    let cancelled = false
    void client
      .command<{ models: AuthModel[] }>(Cmd.AuthModels, { provider: activeId })
      .then((resp) => {
        if (cancelled) return
        store.setAuthModels(resp.ok && resp.payload ? (resp.payload.models ?? []) : [], activeId)
      })
      .catch(() => {
        /* popover falls back to its empty state */
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, configured])

  // Escape closes the popover (backdrop click handled inline below).
  useEffect(() => {
    if (open === 'none') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen('none')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const apply = async (provider: string, model: string | null) => {
    if (busy) return
    setBusy(true)
    setOpen('none')
    try {
      // Pull the freshest YAML (the Advanced pane may hold unsaved edits).
      const cur = await client.command<{ yaml: string }>(Cmd.SettingsGet, {})
      if (!cur.ok || !cur.payload) {
        store.pushNotification('error', cur.error?.message ?? 'failed to read settings')
        return
      }
      const next = withProviderModel(cur.payload.yaml, provider, model)
      const resp = await client.command<SettingsValidateResult>(Cmd.SettingsSave, { yaml: next })
      if (!resp.ok) {
        const problems = resp.payload?.problems?.map((p) => p.message).join(' · ')
        store.pushNotification('error', problems ?? resp.error?.message ?? 'settings save failed')
      }
      // Success: settings.changed lands -> useAuthStatus refetches
      // auth.status -> the chip re-renders with the new provider/model.
    } catch (err) {
      store.pushNotification('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!active) {
    return (
      <button
        onClick={() => store.setSettingsOpen(true)}
        title="No provider configured — open Settings → Provider"
        className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface2 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-faint" />
        <span className="font-mono text-[10px] text-faint">no provider</span>
      </button>
    )
  }

  const { currentModelId, modelLabel } = chipLabels(activeModel, activeId, activeModels)
  const signedIn = (status?.providers ?? [])
    .filter((p) => p.configured)
    .sort((a, b) => providerName(a).localeCompare(providerName(b)))

  const toggle = (which: 'provider' | 'model') => setOpen((cur) => (cur === which ? 'none' : which))

  return (
    <div className="no-drag relative">
      <div className={chipClass(busy)}>
        <span className={dotClass(configured)} />
        <button
          onClick={() => toggle('provider')}
          disabled={busy}
          title="Switch provider (signed-in list)"
          className="font-mono text-[10px] text-mute hover:text-ink rounded px-0.5 -mx-0.5 transition-colors"
        >
          {providerName(active)}
        </button>
        <span className="font-mono text-[10px] text-faint">/</span>
        <button
          onClick={() => toggle('model')}
          disabled={busy || !configured}
          title={modelTitle(configured, currentModelId)}
          className={modelClass(!!activeModel)}
        >
          {modelLabel}
        </button>
      </div>

      {open !== 'none' && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen('none')} />
          <div className="absolute right-0 top-full z-50 mt-1 w-64 max-h-80 overflow-y-auto rounded-lg border border-line bg-base py-1 shadow-xl">
            {open === 'provider' ? (
              <ProviderMenu
                providers={signedIn}
                activeId={activeId}
                onPick={(id) => void apply(id, null)}
                onClose={() => setOpen('none')}
                onManage={() => {
                  setOpen('none')
                  store.setSettingsOpen(true)
                }}
              />
            ) : (
              <ModelMenu
                providerLabel={providerName(active)}
                models={activeModels}
                loading={modelsFor !== activeId}
                currentModelId={currentModelId}
                onPick={(id) => void apply(activeId, id)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Derivations. The chip is small but reads a lot of state: what is selected,
// how it is labelled, and how much of it is dimmed while a save is in flight.
// Each is a pure lookup so the component reads as the chip it draws.
// ---------------------------------------------------------------------------

function activeSelection(status: AuthStatusResult | null) {
  const activeId = status?.activeProvider ?? ''
  const active = status?.providers.find((p) => p.id === activeId) ?? null
  return {
    activeId,
    active,
    configured: !!active?.configured,
    activeModel: status?.activeModel ?? '',
  }
}

/** The model half shows the friendly name and keeps the raw id as the tooltip. */
function chipLabels(activeModel: string, activeId: string, activeModels: AuthModel[]) {
  return {
    currentModelId: activeModel ? stripModelRef(activeModel, activeId) : '',
    modelLabel: activeModel ? modelDisplayName(activeModel, activeId, activeModels) : 'choose model…',
  }
}

function chipClass(busy: boolean): string {
  return `flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${busy ? 'opacity-60' : ''}`
}

function dotClass(configured: boolean): string {
  return `w-1.5 h-1.5 rounded-full shrink-0 ${configured ? 'bg-accent' : 'bg-faint'}`
}

function modelTitle(configured: boolean, currentModelId: string): string {
  return configured ? `Model: ${currentModelId || 'unset'} — click to pick` : 'Sign in to pick a model'
}

/** An unset model is a warning the session cannot run yet; a set one is plain text. */
function modelClass(hasModel: boolean): string {
  const tone = hasModel ? 'text-mute hover:text-ink' : 'text-warn hover:text-ink'
  return `font-mono text-[10px] rounded px-0.5 -mx-0.5 transition-colors disabled:text-faint ${tone}`
}
