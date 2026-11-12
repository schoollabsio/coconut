/**
 * Small shared pieces of the settings → Provider pane. Presentation only: no
 * store reads, no commands — everything arrives as props.
 */
import type { AuthProviderStatus } from '../../protocol'

/** Providers are labelled by pi's display name, falling back to the id. */
export function providerName(p: AuthProviderStatus): string {
  return p.name && p.name !== p.id ? p.name : p.id
}

/** The credential card's one-line feedback (key saved, signed out, …). */
export interface CredentialMessage {
  level: 'ok' | 'err'
  text: string
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-mono uppercase tracking-wider text-faint">{children}</div>
}

export function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dim"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

export function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V2C5.4 2 2 5.4 2 10h2z" />
    </svg>
  )
}

/** Where the credential came from, or an explicit "not signed in". */
export function StatusChip({ p }: { p: AuthProviderStatus }) {
  if (p.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 border border-accent/30 px-2 py-0.5 text-[10px] text-accent">
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
        {p.source || p.type || 'signed in'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[10px] text-dim">
      <span className="w-1.5 h-1.5 rounded-full bg-faint" />
      not signed in
    </span>
  )
}
