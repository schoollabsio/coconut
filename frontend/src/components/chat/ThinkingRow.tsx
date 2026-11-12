import { memo, useState, useRef, useLayoutEffect } from 'react'
import type { ChatMessage } from '../../protocol'
import { FadingTail } from '../StreamingText'
import { RailMarker } from './RailMarker'
import { isNearBottom } from './chatUtils'

type ThinkingRowProps = {
  railKey: string
  message: ChatMessage
}

export default memo(function ThinkingRow({ railKey, message }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isDone = message.thinkingDone === true
  const thinking = message.thinking ?? ''
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow the tail only while the user is near the bottom of the block, so
  // scrolling up to read earlier thought isn't yanked back down (mirrors the
  // outer chat list's at-bottom guard).
  const atBottomRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight)
  }

  useLayoutEffect(() => {
    if (isDone) return
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [thinking, isDone])

  if (!thinking) return null

  if (!isDone) {
    return (
      <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[14px] text-xs leading-[1.45]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[7px] w-[7px] rounded-full border-2 border-dim bg-dim animate-pulse"
      />
        <div ref={scrollRef} onScroll={onScroll} className="min-w-0 max-h-[6em] overflow-y-auto whitespace-pre-wrap italic text-dim" style={{ scrollbarGutter: 'stable' }}>
          <FadingTail text={thinking} className="text-dim" />
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[14px] text-xs leading-[1.45]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[7px] w-[7px] rounded-full border-2 border-dim bg-surface2"
      />
      <div className="min-w-0">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="text-left italic text-dim transition-colors hover:text-mute">
          Thought for {message.thinkingMs != null ? `${Math.round(message.thinkingMs / 1000)} ${Math.round(message.thinkingMs / 1000) === 1 ? 'second' : 'seconds'}` : 'a moment'}
        </button>
        {expanded && (
          <div className="mt-1 max-h-[10lh] overflow-y-auto whitespace-pre-wrap italic text-dim" style={{ scrollbarGutter: 'stable' }}>
            {thinking}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message)
