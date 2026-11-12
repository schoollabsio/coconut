import { memo } from 'react'
import type { ChatMessage } from '../../protocol'

type UserRowProps = {
  message: ChatMessage
  sticky: boolean
}

export default memo(function UserRow({ message, sticky }: UserRowProps) {
  return (
    <div className={sticky ? 'user-sticky' : 'pb-[12px]'} data-user-row-id={message.id}>
      <div className="user-row">
        <div className="user-bubble">{message.text}</div>
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message && prev.sticky === next.sticky)
