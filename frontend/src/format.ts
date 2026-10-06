/** Relative "x minutes ago" formatting for list rows. */
export function relativeTimeMs(t: number): string {
  if (!Number.isFinite(t)) return ''
  const delta = Date.now() - t
  const min = Math.floor(delta / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

/** ISO-timestamp variant of relativeTime (unparseable input passes through). */
export function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return relativeTimeMs(t)
}

/** Human byte sizes for list rows. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
