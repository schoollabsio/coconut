import type { ApprovalRequest } from '../../protocol'
import { store } from '../../store'

/**
 * The way back to a pending approval once the user has looked at something else
 * (a library entry, a tool call). Clicking focuses the oldest pending request,
 * which is what the panel would have shown by default.
 */
export function PendingChip({ approvals }: { approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) return null
  return (
    <button
      onClick={() => store.focusApproval(approvals[0].id)}
      title="Waiting for approval — click to view"
      className="flex items-center gap-1.5 shrink-0 text-[10px] uppercase tracking-wider text-warn hover:brightness-125 transition"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
      {approvals.length} pending
    </button>
  )
}
