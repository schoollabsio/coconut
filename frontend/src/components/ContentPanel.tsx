import { BackendClient } from '../backend'
import { resolvePanelView } from '../panelView'
import { useUIState } from '../store'
import { Markdown } from './Markdown'
import { ApprovalView } from './content/ApprovalView'
import { ContentPicker } from './content/ContentPicker'
import { EmptyPanel } from './content/EmptyPanel'
import { HtmlPreview } from './content/HtmlPreview'
import { PendingChip } from './content/PendingChip'
import { ToolCallView } from './content/ToolCallView'
import { panelHeader } from './content/panelHeader'

/**
 * Right panel: the fenced content area. Precedence (see resolvePanelView):
 *  - approval: a focused pending approval renders What/Why/Diff + Approve
 *  - tool:     a focused tool call renders tool detail
 *  - preview:  a show_content document (latest, or a pinned library entry)
 *  - empty:    placeholder
 *
 * This component owns that precedence and nothing else: the header line comes
 * from panelHeader, and each view lives in components/content/ (ApprovalView,
 * ToolCallView, HtmlPreview / Markdown, EmptyPanel).
 *
 * The header hosts the content-library dropdown: entries are per-agent
 * files (.coconut/agents/<slug>/content/), newest first, and selectable
 * even while an approval is pending (the chip then offers the way back).
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
  const header = panelHeader(view, content?.path ?? null)
  // A pending approval only needs a shortcut when the panel is showing something else.
  const showPendingChip = pendingApprovals.length > 0 && view.kind !== 'approval'

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-base overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${header.dot}`} />
        <ContentPicker
          current={header.fileLabel}
          title={header.pickerTitle}
          entries={contentLibrary}
          client={client}
        />
        {showPendingChip && <PendingChip approvals={pendingApprovals} />}
        <span className={`ml-auto text-[10px] uppercase tracking-wider ${header.statusClass}`}>{header.statusText}</span>
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
        <EmptyPanel hasLibrary={contentLibrary.length > 0} />
      )}
    </div>
  )
}
