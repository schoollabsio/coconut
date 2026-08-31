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

  const approval = pendingApprovals.find((a) => a.id === focusedApprovalId) ?? null

  let dot = 'bg-gray-700'
  let fileLabel = content?.path ?? 'content.md'
  let statusText = 'preview'
  let statusClass = 'text-gray-600'

  if (approval) {
    dot = 'bg-yellow-400 animate-pulse'
    fileLabel = approval.path ?? (approval.kind === 'bash' ? 'shell' : fileLabel)
    statusText = 'pending approval'
    statusClass = 'text-yellow-400'
  } else if (content) {
    dot = 'bg-emerald-400'
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs font-mono text-gray-400 truncate" title={fileLabel}>
          {fileLabel}
        </span>
        <span className={`ml-auto text-[10px] uppercase tracking-wider ${statusClass}`}>{statusText}</span>
      </div>

      {approval ? (
        <ApprovalView approval={approval} client={client} />
      ) : content ? (
        <div className="flex-1 overflow-y-auto p-4">
          <Markdown text={content.content} />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="border border-dashed border-gray-700 rounded-lg px-8 py-10 text-center">
            <div className="text-gray-500 text-sm">Agent content renders here</div>
            <div className="text-gray-600 text-xs mt-1 font-mono">awaiting output…</div>
          </div>
        </div>
      )}
    </div>
  )
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
              <div className="text-[10px] uppercase tracking-wider text-yellow-300/80 mb-1">What</div>
              <p className="text-sm text-gray-200 leading-relaxed">{approval.what}</p>
            </div>
          )}
          {approval.why && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-yellow-300/80 mb-1">Why</div>
              <div className="text-sm text-gray-400 leading-relaxed">{approval.why}</div>
            </div>
          )}
          {approval.diff && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-yellow-300/80 mb-1">Diff</div>
              <DiffView diff={approval.diff} />
            </div>
          )}
        </>
      ) : (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-yellow-300/80 mb-1">Command</div>
          <pre className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5 font-mono text-xs text-gray-200 overflow-x-auto whitespace-pre-wrap">
            {approval.command}
          </pre>
          <p className="text-xs text-gray-500 mt-2">
            This command is not on the whitelist. Approve to run it once; approve similar commands automatically by
            extending the whitelist in settings.
          </p>
        </div>
      )}

      <div className="flex justify-end items-center gap-3">
        <button
          onClick={() => respond('dismiss')}
          title="Skip this for now — tell the agent what to change in chat"
          className="px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={() => respond('allow')}
          className="px-3 py-1.5 rounded-lg text-xs bg-emerald-500 hover:bg-emerald-400 text-white transition-colors"
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
    <div className="rounded-lg border border-gray-800 bg-gray-950 py-2 font-mono text-xs leading-5 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} className={`px-3 whitespace-pre ${diffLineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('---') || line.startsWith('+++')) return 'text-gray-600'
  if (line.startsWith('@@') || line === '…') return 'text-blue-300/80 bg-blue-500/5'
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-300'
  return 'text-gray-400'
}
