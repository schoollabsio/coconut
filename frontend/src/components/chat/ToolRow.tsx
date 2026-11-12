import { memo } from 'react'
import { RailMarker } from './RailMarker'
import type { ToolCall, ToolCallStatus } from '../../protocol'
import { store } from '../../store'

type Lane = 'main' | 'child'

type ToolRowProps = {
  railKey: string
  call: ToolCall
  lane: Lane
  focused: boolean
}

export default memo(function ToolRow({ railKey, call, lane, focused }: ToolRowProps) {
  const displayText = call.what || call.label
  const pending = call.status === 'pending_approval'

  const onClick = () => {
    if (pending) {
      store.focusApproval(call.approvalId ?? null)
      return
    }
    store.focusToolCall(call.id)
  }


  return (
    <button
      type="button"
      onClick={onClick}
      title={call.why || undefined}
      className={rowClassName(lane, pending, focused)}
    >
      {lane === 'child' && <div className="w-[20px] shrink-0" />}
      <RailMarker
        railKey={railKey}
        spanClassName={`relative z-10 h-[10px] w-[10px] rounded-full ${markerClass(call.status)}`}
      />
      <span className="min-w-0 flex-1 truncate">{displayText}</span>
      {!pending && (
        <span className={`ml-auto shrink-0 text-[11px] text-faint transition-opacity ${focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          ⤢ detail
        </span>
      )}
    </button>
  )
}, (prev, next) => prev.call === next.call && prev.lane === next.lane && prev.focused === next.focused)

// ---------------------------------------------------------------------------
// Styling by status. Each is a small lookup over ToolCallStatus / focus, kept
// out of the JSX so the row's own render says what a row is, not how its
// Tailwind classes are assembled.
// ---------------------------------------------------------------------------

function rowClassName(lane: Lane, pending: boolean, focused: boolean): string {
  const indent = lane === 'child' ? 'flex pb-[14px]' : 'flex pb-[22px]'
  const tone = pending ? 'text-warn' : focused ? 'text-ink' : 'text-dim hover:text-mute'
  return `${indent} group w-full items-start gap-x-3 rounded-[6px] py-1.5 text-left text-[13px] leading-[1.5] transition-colors cursor-pointer ${tone}`
}

/** The rail dot: error is red, running pulses, anything else is the idle outline. */
function markerClass(status: ToolCallStatus): string {
  if (status === 'error') return 'bg-danger'
  if (status === 'running') return 'bg-ok animate-pulse'
  return 'bg-dim border-info'
}
