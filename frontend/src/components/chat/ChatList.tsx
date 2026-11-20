import { RailOverlay } from './RailOverlay'
import UserRow from './UserRow'
import ThinkingRow from './ThinkingRow'
import TextRow from './TextRow'
import ToolRow from './ToolRow'
import ApprovalCardRow from './ApprovalCardRow'
import GroupRow from './GroupRow'
import type { RenderRow } from './chatUtils'
import type { RailPath } from '../../railGeometry'
import type { BackendClient } from '../../backend'
import type { AgentStatus, ApprovalRequest, ChatMessage, ToolCall } from '../../protocol'

type Lane = 'main' | 'child'

/** Per-render context threaded to every row, so the list body stays a plain map. */
type RowContext = {
  client: BackendClient
  approvalById: Map<string, ApprovalRequest>
  focusedApprovalId: string | null
  focusedToolCallId: string | null
  latestUserId: string | null
}

interface ChatListProps extends RowContext {
  railRows: RenderRow[]
  railPaths: RailPath[]
  status: AgentStatus
  lastMsg?: ChatMessage
  hasLiveThinking: boolean
  busy: boolean
  scrollRef: React.RefObject<HTMLDivElement>
  contentRef: React.RefObject<HTMLDivElement>
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
}

/**
 * A tool call: an inline approval card while it awaits a decision, a compact
 * row otherwise. Covers top-level calls and the children of an expanded group.
 */
function CallRow({ call, railKey, lane, ctx }: { call: ToolCall; railKey: string; lane: Lane; ctx: RowContext }) {
  const approval = call.approvalId ? ctx.approvalById.get(call.approvalId) : undefined
  if (call.status === 'pending_approval' && approval) {
    return (
      <ApprovalCardRow
        railKey={railKey}
        lane={lane}
        approvalId={approval.id}
        kind={approval.kind}
        what={approval.what || approval.title}
        why={approval.why}
        command={approval.command}
        focused={ctx.focusedApprovalId === approval.id}
        client={ctx.client}
      />
    )
  }
  return <ToolRow railKey={railKey} call={call} lane={lane} focused={ctx.focusedToolCallId === call.id} />
}

function RailRowItem({ row, ctx }: { row: RenderRow; ctx: RowContext }) {
  switch (row.kind) {
    case 'user':
      return <UserRow message={row.message} sticky={row.key === ctx.latestUserId} />
    case 'thinking':
      return <ThinkingRow railKey={row.railKey} message={row.message} />
    case 'text':
      return <TextRow railKey={row.railKey} message={row.message} />
    case 'tool':
      return <CallRow call={row.call} railKey={row.railKey} lane={row.lane} ctx={ctx} />
    case 'group':
      return <GroupRow railKey={row.railKey} group={row.group} expanded={row.expanded} />
    case 'group-tool':
      return <CallRow call={row.call} railKey={row.railKey} lane="child" ctx={ctx} />
  }
}

function BusyHint({ status }: { status: AgentStatus }) {
  if (status === 'awaiting_tool_approval') {
    return <span className="mt-1 text-sm italic text-dim subtle-pulse">waiting for your approval…</span>
  }
  return (
    <span className="mt-1 flex items-center gap-2 text-sm italic text-dim">
      <svg className="h-3.5 w-3.5 animate-spin text-dim" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Generating…
    </span>
  )
}

export function ChatList({
  railRows,
  railPaths,
  status,
  lastMsg,
  hasLiveThinking,
  busy,
  scrollRef,
  contentRef,
  onScroll,
  ...ctx
}: ChatListProps) {
  const showBusy = busy && !lastMsg?.streaming && !hasLiveThinking
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ overflowAnchor: 'none' }}
      className="max-h-96 overflow-y-auto pr-2 text-base md:max-h-none md:flex-1"
    >
      <div ref={contentRef} className="relative min-h-full">
        <RailOverlay rows={railRows} paths={railPaths} />
        <div className="relative z-10 flex flex-col">
          {railRows.length === 0 && (
            <div className="px-2 pt-4 text-sm italic text-faint">No messages yet — ask the agent anything.</div>
          )}
          {railRows.map((row) => (
            <RailRowItem key={row.key} row={row} ctx={ctx} />
          ))}
          {showBusy && <BusyHint status={status} />}
        </div>
      </div>
    </div>
  )
}
