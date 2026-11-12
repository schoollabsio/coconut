import { memo } from 'react'
import { RailMarker } from './RailMarker'
import type { ToolCallGroup } from '../../toolGrouping'
import { store } from '../../store'

type GroupRowProps = {
  railKey: string
  group: ToolCallGroup
  expanded: boolean
}

export default memo(function GroupRow({ railKey, group, expanded }: GroupRowProps) {
  return (
    <button
      type="button"
      onClick={() => store.toggleGroup(group.key)}
      className={`grid w-full grid-cols-[20px_1fr] gap-x-3 rounded-[6px] text-left text-[13.5px] leading-[1.4] transition-colors ${expanded ? 'pb-[14px]' : 'pb-[22px]'}`}
    >
      <RailMarker
        railKey={railKey}
        spanClassName="rail-marker-branch relative z-10 flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-info bg-base text-info"
      >
        <span className="text-[9px] leading-none">⎇</span>
      </RailMarker>
      <div className="flex items-baseline gap-2">
        <span className={`font-medium ${expanded ? 'text-ink' : 'italic text-dim'}`}>{group.label}</span>
        <span className="text-[11px] text-faint">{group.toolCalls.length} calls</span>
      </div>
    </button>
  )
}, (prev, next) => {
  const sameGroup = (a: ToolCallGroup, b: ToolCallGroup) => (
    a.key === b.key &&
    a.label === b.label &&
    a.grouper === b.grouper &&
    a.toolCalls.length === b.toolCalls.length &&
    a.toolCalls.every((call, index) => call === b.toolCalls[index])
  )
  return sameGroup(prev.group, next.group) && prev.expanded === next.expanded
})
