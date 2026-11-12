import { memo } from 'react'
import type { ChatMessage } from '../../protocol'
import { Markdown } from '../Markdown'
import { StreamingText } from '../StreamingText'
import { RailMarker } from './RailMarker'

const MemoMarkdown = memo(Markdown)

type TextRowProps = {
  railKey: string
  message: ChatMessage
}

export default memo(function TextRow({ railKey, message }: TextRowProps) {
  const streaming = message.streaming ?? false
  return (
    <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[22px] text-sm leading-[1.5]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[10px] w-[10px] rounded-full border-2 border-accent bg-accent"
      />
      <div className="assistant-text min-w-0">
        {streaming ? <StreamingText text={message.text} /> : <MemoMarkdown text={message.text} />}
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message)
