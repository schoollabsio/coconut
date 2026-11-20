import { memo } from 'react'
import type { BackendClient } from '../../backend'
import { Cmd } from '../../protocol'
import { store } from '../../store'
import { ApprovalClock } from '../ApprovalClock'

type ApprovalCardRowProps = {
  railKey: string
  lane: 'main' | 'child'
  approvalId: string
  kind: 'propose_edit' | 'bash'
  what?: string
  why?: string
  command?: string
  focused: boolean
  client: BackendClient
}

export default memo(function ApprovalCardRow({
  railKey,
  lane,
  approvalId,
  kind,
  what,
  why,
  command,
  focused,
  client,
}: ApprovalCardRowProps) {
  const approve = () => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId, decision: 'allow' })
  }
  const dismiss = () => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId, decision: 'dismiss' })
  }

  const gridClass = lane === 'child' ? 'grid grid-cols-[20px_20px_1fr] gap-x-3 pb-[8px] leading-[1.45]' : 'grid grid-cols-[20px_1fr] gap-x-3 pb-[8px] leading-[1.45]'
  const detailsLabel = kind === 'propose_edit' ? 'full diff ⤢' : 'details ⤢'

  return (
    <div className={gridClass}>
      {lane === 'child' && <div className="rail none" />}
      <div className="rail flex justify-center overflow-visible pt-[16px]">
        <span data-rail-key={railKey} className="rail-marker-dot relative z-10 h-[10px] w-[10px] rounded-full border-2 border-warn bg-warn animate-pulse" />
      </div>
      <div className={`approval min-w-0 ${focused ? 'ring-1 ring-[rgba(217,160,91,.22)]' : ''}`}>
        <div className="k">Approval needed · {kind}</div>
        {what && <div className="what">{what}</div>}
        {why && <div className="why">{why}</div>}
        {kind === 'bash' && command && <pre className="command">{command}</pre>}
        <ApprovalClock approval={{ id: approvalId, what, why }} className="mt-2 text-[11px]" />
        <div className="actions">
          <button type="button" onClick={approve} title="Approve (⌘+Return)" className="btn-approve">
            Approve
          </button>
          <button type="button" onClick={dismiss} className="btn-dismiss">
            Dismiss
          </button>
          <button type="button" onClick={() => store.focusApproval(approvalId)} className="details-link">
            {detailsLabel}
          </button>
        </div>
        <div className="hint">or just type a reply below — sending a message dismisses this request</div>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.railKey === next.railKey &&
  prev.lane === next.lane &&
  prev.approvalId === next.approvalId &&
  prev.kind === next.kind &&
  prev.what === next.what &&
  prev.why === next.why &&
  prev.command === next.command &&
  prev.focused === next.focused &&
  prev.client === next.client)
