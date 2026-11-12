import type { ReactNode } from 'react'
import type { AuthModel, AuthProviderStatus } from '../../protocol'
import { providerName } from './pieces'

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-1.5 pb-1 text-[10px] font-mono uppercase tracking-wider text-faint">{children}</div>
}

export function MenuRow({ label, sub, checked, onClick }: { label: string; sub?: string; checked?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface2 transition-colors">
      <span className="w-3 shrink-0 self-center text-[10px] text-accent">{checked ? '✓' : ''}</span>
      <span className="text-xs text-ink truncate">{label}</span>
      {sub && <span className="text-[10px] text-faint truncate">{sub}</span>}
    </button>
  )
}

function MenuHint({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-[11px] text-faint">{children}</div>
}

/** A model's own label, and its id as a secondary line when the two differ. */
function modelLabels(m: AuthModel): { label: string; sub?: string } {
  return m.name && m.name !== m.id ? { label: m.name, sub: m.id } : { label: m.id }
}

/** The provider half of the header chip's popover: signed-in providers + Settings. */
export function ProviderMenu({
  providers,
  activeId,
  onPick,
  onClose,
  onManage,
}: {
  providers: AuthProviderStatus[]
  activeId: string
  onPick: (id: string) => void
  /** Just dismiss the popover — used for the provider that is already active. */
  onClose: () => void
  onManage: () => void
}) {
  return (
    <>
      <MenuLabel>signed-in providers</MenuLabel>
      {providers.map((p) => (
        <MenuRow
          key={p.id}
          checked={p.id === activeId}
          label={providerName(p)}
          // Re-picking the active provider would restart the sidecar for nothing.
          onClick={() => (p.id === activeId ? onClose() : onPick(p.id))}
        />
      ))}
      <div className="my-1 border-t border-line" />
      <MenuRow label="Manage providers…" onClick={onManage} />
    </>
  )
}

/** The model half: the active provider's list, or why there is nothing to list. */
export function ModelMenu({
  providerLabel,
  models,
  loading,
  currentModelId,
  onPick,
}: {
  providerLabel: string
  models: AuthModel[]
  /** auth.models for this provider has not landed yet. */
  loading: boolean
  currentModelId: string
  onPick: (id: string) => void
}) {
  return (
    <>
      <MenuLabel>models — {providerLabel}</MenuLabel>
      {loading ? (
        <MenuHint>loading…</MenuHint>
      ) : models.length === 0 ? (
        <MenuHint>no models listed for this provider</MenuHint>
      ) : (
        models.map((m) => {
          const { label, sub } = modelLabels(m)
          return <MenuRow key={m.id} checked={currentModelId === m.id} label={label} sub={sub} onClick={() => onPick(m.id)} />
        })
      )}
    </>
  )
}
