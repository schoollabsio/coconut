import { useEffect } from 'react'

import { BackendClient } from '../backend'
import { Cmd, type ApprovalRequest } from '../protocol'
import { store, useUIState } from '../store'
import { Markdown } from './Markdown'

/**
 * Right panel: the fenced content area. Three modes:
 *  - approval: a focused pending approval renders What/Why/Diff + Approve
 *  - preview:  the agent's latest show_content document
 *  - empty:    placeholder
 */
export function ContentPanel({ client }: { client: BackendClient }) {
  const content = useUIState((s) => s.content)
  const pendingApprovals = useUIState((s) => s.pendingApprovals)
  const focusedApprovalId = useUIState((s) => s.focusedApprovalId)

  // Fall back to the first pending approval if focus dangles — a pending
  // approval must always be visible.
  const approval = pendingApprovals.find((a) => a.id === focusedApprovalId) ?? pendingApprovals[0] ?? null

  let dot = 'bg-raised'
  let fileLabel = content?.path ?? 'content.md'
  let statusText = 'preview'
  let statusClass = 'text-faint'

  if (approval) {
    dot = 'bg-warn animate-pulse'
    fileLabel = approval.path ?? (approval.kind === 'bash' ? 'shell' : fileLabel)
    statusText = 'pending approval'
    statusClass = 'text-warn'
  } else if (content) {
    dot = 'bg-ok'
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-base overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs font-mono text-mute truncate" title={fileLabel}>
          {fileLabel}
        </span>
        <span className={`ml-auto text-[10px] uppercase tracking-wider ${statusClass}`}>{statusText}</span>
      </div>

      {approval ? (
        <ApprovalView approval={approval} client={client} />
      ) : content ? (
        content.format === 'html' ? (
          <HtmlPreview html={content.content} path={content.path} />
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-3xl mx-auto">
              <Markdown text={content.content} className="text-ink" />
            </div>
          </div>
        )
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="border border-dashed border-linestrong rounded-lg px-8 py-10 text-center">
            <div className="text-dim text-sm">Agent content renders here</div>
            <div className="text-faint text-xs mt-1 font-mono">awaiting output…</div>
          </div>
        </div>
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

function ApprovalView({ approval, client }: { approval: ApprovalRequest; client: BackendClient }) {
  const respond = (decision: 'allow' | 'dismiss') => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId: approval.id, decision })
  }

  // Cmd+Return (or Ctrl+Return on non-Mac) approves the currently focused approval.
  // Registered at the document level so it works regardless of which element has focus,
  // consistent with SettingsModal's Escape-to-close pattern.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'NumpadEnter')) {
        e.preventDefault()
        respond('allow')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [approval.id, client])

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
