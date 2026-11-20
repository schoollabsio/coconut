import { memo, useState, useRef } from 'react'
import type { ChatMessage } from '../../protocol'
import { FadingTail } from '../StreamingText'
import { RailMarker } from './RailMarker'
import { useTailFollow } from './useTailFollow'

type ThinkingRowProps = {
  railKey: string
  message: ChatMessage
}

export default memo(function ThinkingRow({ railKey, message }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isDone = message.thinkingDone === true
  const thinking = message.thinking ?? ''
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Follow the tail only while we own it, so scrolling up to read an earlier
  // thought isn't yanked back down. This box is only 6em tall, so a single
  // streamed line is enough to break a distance-from-bottom reading of "the user
  // left" — see tailFollow.ts for why the decision is intent-based.
  const { onScroll } = useTailFollow(scrollRef, bodyRef, { enabled: !isDone })

  if (!thinking) return null

  if (!isDone) {
    return (
      <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[14px] text-xs leading-[1.45]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[7px] w-[7px] rounded-full border-2 border-dim bg-dim animate-pulse"
      />
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-w-0 max-h-[6em] overflow-y-auto whitespace-pre-wrap italic text-dim"
          // We own bottom-following here; scroll anchoring would be a second writer
          // of scrollTop, producing scroll events we then have to explain.
          style={{ scrollbarGutter: 'stable', overflowAnchor: 'none' }}
        >
          {/* Block wrapper for the ResizeObserver: an inline span has no reliable
              content box to watch for growth. */}
          <div ref={bodyRef}>
            <FadingTail text={thinking} className="text-dim" />
          </div>
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
