import { useEffect, useRef, useState } from 'react'
import { BackendClient } from '../backend'
import { formatBytes, relativeTimeMs } from '../format'
import { resolvePanelView } from '../panelView'
import { Cmd, type ApprovalRequest, type ContentEntry, type ToolCall } from '../protocol'
import { store, useUIState } from '../store'
import { Markdown } from './Markdown'

/**
 * Right panel: the fenced content area. Precedence (see resolvePanelView):
 *  - approval: a focused pending approval renders What/Why/Diff + Approve
 *  - tool:     a focused tool call renders tool detail
 *  - preview:  a show_content document (latest, or a pinned library entry)
 *  - empty:    placeholder
 *
 * The header hosts the content-library dropdown: entries are per-agent
 * files (.coconut/agents/<slug>/content/), newest first, and selectable
 * even while an approval is pending (a chip then offers the way back).
 */
export function ContentPanel({ client }: { client: BackendClient }) {
  const content = useUIState((s) => s.content)
  const contentLibrary = useUIState((s) => s.contentLibrary)
  const pendingApprovals = useUIState((s) => s.pendingApprovals)
  const focusedApprovalId = useUIState((s) => s.focusedApprovalId)
  const toolCalls = useUIState((s) => s.agent.toolCalls)
  const focusedToolCallId = useUIState((s) => s.focusedToolCallId)
  const contentPinned = useUIState((s) => s.contentPinned)

  const view = resolvePanelView({ focusedApprovalId, focusedToolCallId, contentPinned, content, pendingApprovals, toolCalls })

  let dot = 'bg-raised'
  let fileLabel = content?.path ?? 'content.md'
  let statusText = 'preview'
  let statusClass = 'text-faint'

  if (view.kind === 'approval') {
    dot = 'bg-warn animate-pulse'
    fileLabel = view.approval.path ?? (view.approval.kind === 'bash' ? 'shell' : fileLabel)
    statusText = 'pending approval'
    statusClass = 'text-warn'
  } else if (view.kind === 'tool') {
    dot = toolStatusDotClass(view.call)
    fileLabel = view.call.path ?? view.call.label
    statusText = 'tool call'
    statusClass = 'text-info'
  } else if (view.kind === 'content') {
    dot = 'bg-ok'
    fileLabel = view.doc.path
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-base overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <ContentPicker
          current={fileLabel}
          title={view.kind === 'content' && view.doc.sourcePath ? `copied from ${view.doc.sourcePath}` : undefined}
          entries={contentLibrary}
          client={client}
        />
        {pendingApprovals.length > 0 && view.kind !== 'approval' && (
          <button
            onClick={() => store.focusApproval(pendingApprovals[0].id)}
            title="Waiting for approval — click to view"
            className="flex items-center gap-1.5 shrink-0 text-[10px] uppercase tracking-wider text-warn hover:brightness-125 transition"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
            {pendingApprovals.length} pending
          </button>
        )}
        <span className={`ml-auto text-[10px] uppercase tracking-wider ${statusClass}`}>{statusText}</span>
      </div>

      {view.kind === 'approval' ? (
        <ApprovalView approval={view.approval} client={client} />
      ) : view.kind === 'tool' ? (
        <ToolCallView call={view.call} />
      ) : view.kind === 'content' ? (
        view.doc.format === 'html' ? (
          <HtmlPreview html={view.doc.content} path={view.doc.path} />
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-3xl mx-auto">
              <Markdown text={view.doc.content} className="text-ink" />
            </div>
          </div>
        )
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="border border-dashed border-linestrong rounded-lg px-8 py-10 text-center">
            <div className="text-dim text-sm">Agent content renders here</div>
            <div className="text-faint text-xs mt-1 font-mono">
              {contentLibrary.length > 0 ? 'pick an entry from the library above' : 'awaiting output…'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Filterable dropdown of the agent's content library (newest first). */
function ContentPicker({
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
      setFilter('')
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
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
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

function HtmlPreview({ html, path }: { html: string; path: string }) {
  // Inject a <style> that forces the iframe document to be scrollable even
  // when the rendered HTML sets overflow:hidden on html/body (common in
  // full-bleed layouts). We aim to place it as late as possible in <head>
  // for cascade priority (so it can override !important rules too), falling
  // back to before <body> or the start of the string. The HTML parser
  // relocates a leading <style> into <head> automatically.
  const scrollGuard = '<style>html,body{margin:0;height:100%;overflow:auto!important}</style>'
  const srcDoc = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${scrollGuard}</head>`)
    : /<body/i.test(html)
      ? html.replace(/<body/i, `${scrollGuard}<body`)
      : `${scrollGuard}${html}`
  return (
    <iframe
      srcDoc={srcDoc}
      sandbox=""
      title={path}
      className="flex-1 w-full h-full border-none bg-base"
    />
  )
}

function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Tool name</div>
        <p className="text-lg text-ink leading-relaxed">{call.tool}</p>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Full label</div>
        <div className="text-base text-mute leading-relaxed">{call.label}</div>
      </div>

      {call.path && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Path</div>
          <div className="text-base text-mute leading-relaxed">{call.path}</div>
        </div>
      )}

      {call.what && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">What</div>
          <p className="text-lg text-ink leading-relaxed">{call.what}</p>
        </div>
      )}

      {call.why && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Why</div>
          <div className="text-base text-mute leading-relaxed">{call.why}</div>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Status</div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${toolStatusDotClass(call)}`} />
          <span className="text-base text-ink leading-relaxed">{formatToolStatus(call.status)}</span>
        </div>
      </div>

      {call.groupLabel && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-info/80 mb-1">Group label</div>
          <div className="text-base text-mute leading-relaxed">{call.groupLabel}</div>
        </div>
      )}
    </div>
  )
}

function toolStatusDotClass(call: ToolCall): string {
  switch (call.status) {
    case 'running':
      return 'bg-accent animate-pulse'
    case 'error':
      return 'bg-danger'
    case 'done':
      return 'bg-ok'
    case 'pending_approval':
      return 'bg-warn animate-pulse'
    default:
      return 'bg-raised'
  }
}

function formatToolStatus(status: ToolCall['status']): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'pending_approval':
      return 'pending approval'
    default:
      return status
  }
}

function ApprovalView({ approval, client }: { approval: ApprovalRequest; client: BackendClient }) {
  const respond = (decision: 'allow' | 'dismiss') => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId: approval.id, decision })
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      {approval.kind === 'propose_edit' ? (
        <>
          {approval.what && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">What</div>
              <p className="text-lg text-ink leading-relaxed">{approval.what}</p>
            </div>
          )}
          {approval.why && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">Why</div>
              <div className="text-base text-mute leading-relaxed">{approval.why}</div>
            </div>
          )}
          {approval.diff && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">Diff</div>
              <DiffView diff={approval.diff} />
            </div>
          )}
        </>
      ) : (
        <>
          {approval.what && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">What</div>
              <p className="text-lg text-ink leading-relaxed">{approval.what}</p>
            </div>
          )}
          {approval.why && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">Why</div>
              <div className="text-base text-mute leading-relaxed">{approval.why}</div>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-warn/80 mb-1">Command</div>
            <pre className="rounded-lg border border-line bg-base px-3 py-2.5 font-mono text-xs text-ink overflow-x-auto whitespace-pre-wrap">
              {approval.command}
            </pre>
            <p className="text-xs text-dim mt-2">
              This command is not on the whitelist. Approve to run it once; approve similar commands automatically by
              extending the whitelist in settings.
            </p>
          </div>
        </>
      )}

      <div className="flex justify-end items-center gap-3">
        <button
          onClick={() => respond('dismiss')}
          title="Skip this for now — tell the agent what to change in chat"
          className="px-3 py-1.5 rounded-lg text-xs text-dim hover:text-mute hover:bg-surface2 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={() => respond('allow')}
          title="Approve (⌘+Return)"
          className="px-3 py-1.5 rounded-lg text-xs bg-ok hover:brightness-110 hover:bg-ok text-onaccent transition-colors"
        >
          Approve
        </button>
      </div>
    </div>
  )
}

/** Line-wise diff rendering, matching the mockup's DIFF_CLASSES. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <div className="rounded-lg border border-line bg-base py-2 font-mono text-xs leading-5 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} className={`px-3 whitespace-pre ${diffLineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('---') || line.startsWith('+++')) return 'text-faint'
  if (line.startsWith('@@') || line === '…') return 'text-info/80 bg-accentsoft'
  if (line.startsWith('+')) return 'bg-ok/10 text-ok'
  if (line.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-mute'
}
