import { store, useUIState } from '../store'

/**
 * Left panel: chronological tool-call log. Pending-approval entries are
 * highlighted and clickable — clicking focuses the approval in the
 * content panel (mockup behavior).
 */
export function ToolLog() {
  const toolCalls = useUIState((s) => s.agent.toolCalls)
  const pendingApprovals = useUIState((s) => s.pendingApprovals)
  const focusedApprovalId = useUIState((s) => s.focusedApprovalId)

  if (toolCalls.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 overflow-y-auto max-h-96 md:max-h-none md:flex-1 pr-1 text-xs">
        <div className="px-2.5 py-1.5 text-gray-600 italic">No tool activity yet</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 overflow-y-auto max-h-96 md:max-h-none md:flex-1 pr-1 text-xs">
      {toolCalls.map((call) => {
        const pending = call.status === 'pending_approval'
        const focused = pending && call.approvalId === focusedApprovalId
        const sp = call.label.split(' ')
        const verb = sp[0]
        const rest = sp.slice(1).join(' ')

        if (pending) {
          return (
            <button
              key={call.id}
              onClick={() => store.focusApproval(call.approvalId ?? null)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors ${
                focused ? 'bg-gray-800 text-yellow-200' : 'text-yellow-300 hover:bg-gray-800/70'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
              <span className="truncate">
                <span className="font-semibold italic">{verb}</span>
                {rest ? ' ' + rest : ''}
              </span>
            </button>
          )
        }

        return (
          <div key={call.id} className="px-2.5 py-1.5 text-gray-400 truncate flex items-center gap-2">
            {call.status === 'running' && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
            )}
            {call.status === 'error' && <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />}
            <span>
              <span className="font-semibold italic">{verb}</span>
              {rest ? ' ' + rest : ''}
            </span>
          </div>
        )
      })}
      {pendingApprovals.length > 0 && <div className="h-1" />}
    </div>
  )
}
