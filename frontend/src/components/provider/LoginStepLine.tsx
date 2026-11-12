import type { AuthEvent } from '../../protocol'

/**
 * One `auth.login.step` line. The shapes differ enough to branch outright:
 * a URL gets a link, a device code gets the copyable code block, everything
 * else is text.
 */
export function LoginStepLine({ ev }: { ev: AuthEvent }) {
  if (ev.type === 'auth_url' && ev.url) {
    return (
      <div className="text-xs text-mute space-y-1">
        {ev.message && <span>{ev.message}</span>}
        <a href={ev.url} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">
          {ev.url} ↗
        </a>
      </div>
    )
  }
  if (ev.type === 'device_code' && ev.userCode) {
    const link = ev.url || ev.verificationUri
    return (
      <div className="rounded-lg bg-surface2/60 border border-line px-3 py-2 space-y-1.5">
        <span className="block text-xs text-mute">
          {ev.message || 'Enter this code on the sign-in page, then come back — completion is detected automatically.'}
        </span>
        <div className="flex items-center gap-2">
          <code className="font-mono text-base tracking-widest text-ink select-all">{ev.userCode}</code>
          <span className="text-[10px] text-dim">click to copy</span>
        </div>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="block text-xs text-accent hover:underline break-all">
            {link} ↗
          </a>
        )}
      </div>
    )
  }
  if (ev.type === 'progress') {
    return <div className="text-[11px] text-dim">{ev.message}</div>
  }
  return <div className="text-xs text-mute">{ev.message}</div>
}
