import type { ReactNode } from 'react'

/**
 * The shared field block used by the approval and tool-call detail views: a
 * small uppercase label over a value. `warn` is the approval accent, `info`
 * the tool-call one.
 */
export function Field({ label, tone = 'info', children }: { label: string; tone?: 'info' | 'warn'; children?: ReactNode }) {
  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wider mb-1 ${tone === 'warn' ? 'text-warn/80' : 'text-info/80'}`}>{label}</div>
      {children}
    </div>
  )
}

/** Primary value — the sentence the user should actually read. */
export function Prose({ children }: { children: ReactNode }) {
  return <p className="text-lg text-ink leading-relaxed">{children}</p>
}

/** Secondary value — an id, a path, a group name. */
export function Meta({ children }: { children: ReactNode }) {
  return <div className="text-base text-mute leading-relaxed">{children}</div>
}
