import { useEffect, useRef, useState } from 'react'
import { BackendClient } from '../../backend'
import { formatBytes, relativeTimeMs } from '../../format'
import { Cmd, type ContentEntry } from '../../protocol'
import { store } from '../../store'

/** Filterable dropdown of the agent's content library (newest first). */
export function ContentPicker({
  current,
  title,
  entries,
  client,
}: {
  current: string
  title?: string
  entries: ContentEntry[]
  client: BackendClient
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilter('')
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive(0)
      inputRef.current?.focus()
    }
  }, [open])

  const q = filter.trim().toLowerCase()
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries

  const pick = (name: string) => {
    setOpen(false)
    store.pinContent()
    void client.command(Cmd.ContentSelect, { name })
  }

  return (
    <div className="relative min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title ?? 'Content library'}
        className="flex items-center gap-1 min-w-0 text-xs font-mono text-mute hover:text-ink transition-colors"
      >
        <span className="truncate">{current}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7 7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-80 max-w-[70vw] max-h-80 flex flex-col rounded-lg border border-linestrong bg-surface shadow-2xl">
            <div className="p-1.5 border-b border-line">
              <input
                ref={inputRef}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setActive(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setOpen(false)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActive((i) => Math.min(i + 1, filtered.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActive((i) => Math.max(i - 1, 0))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    const entry = filtered[active] ?? filtered[0]
                    if (entry) pick(entry.name)
                  }
                }}
                placeholder="Filter content…"
                spellCheck={false}
                aria-label="Filter content library"
                className="w-full bg-surface2 text-xs text-ink rounded-md px-2 py-1 border border-linestrong focus:border-linestrong outline-none font-mono"
              />
            </div>
            <div className="flex-1 overflow-y-auto" role="listbox">
              {filtered.length === 0 && (
                <div className="px-3 py-3 text-xs text-dim">
                  {entries.length === 0 ? 'No content yet — documents the agent shows you appear here.' : 'No matches.'}
                </div>
              )}
              {filtered.map((entry, i) => (
                <button
                  key={entry.name}
                  role="option"
                  aria-selected={entry.name === current}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(entry.name)}
                  className={`w-full text-left px-3 py-1.5 border-b border-line/60 transition-colors ${
                    i === active ? 'bg-surface2' : 'hover:bg-surface2/50'
                  }`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-ink font-mono truncate">{entry.name}</span>
                    {entry.format === 'html' && (
                      <span className="shrink-0 text-[9px] uppercase tracking-wide text-info">html</span>
                    )}
                    <span className="ml-auto shrink-0 text-[10px] text-faint">{relativeTimeMs(entry.updatedAt)}</span>
                  </div>
                  <div className="text-[10px] text-faint font-mono">{formatBytes(entry.sizeBytes)}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
