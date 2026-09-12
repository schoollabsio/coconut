import { memo, useEffect, useRef, useState } from 'react'
import { ChatMessage } from '../protocol'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { useUIState } from '../store'
import { Markdown } from './Markdown'
import { FadingTail, StreamingText } from './StreamingText'

/** Memoized markdown. The chat list re-renders on every token, but only
 *  the streaming message's text actually changes — memo lets every other
 *  block skip its full re-parse (previously every past message re-ran
 *  ReactMarkdown per token: the main flicker/jank source). */
const MemoMarkdown = memo(Markdown)

type ThinkingGroup = {
  messages: ChatMessage[]
  totalMs: number
}

type GroupedMessage = 
  | { type: 'assistant'; message: ChatMessage; preThinking: ThinkingGroup | null; key: string }
  | { type: 'user'; message: ChatMessage; key: string }
  | { type: 'orphaned_thinking'; group: ThinkingGroup; key: string }

const MAX_INPUT_HEIGHT = 160

function formatThinkingDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
  const mins = Math.round(secs / 60)
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
}

/** Check if a message is a thinking-only (assistant with thinking but no text). */
function isThinkingOnly(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    !!m.thinking &&
    m.thinking.length > 0 &&
    m.thinkingDone === true &&
    (!m.text || m.text.length === 0)
  )
}
/** Group messages, merging thinking groups into following assistant messages with text. */
function groupMessages(messages: ChatMessage[]): GroupedMessage[] {
  const result: GroupedMessage[] = []
  let i = 0
  
  while (i < messages.length) {
    // Collect any consecutive thinking-only messages
    const preThinking: ChatMessage[] = []
    while (i < messages.length && isThinkingOnly(messages[i])) {
      preThinking.push(messages[i])
      i++
    }
    
    if (i >= messages.length) {
      // End of stream with trailing thinking-only messages
      if (preThinking.length > 0) {
        const totalMs = preThinking.reduce((sum, m) => sum + (m.thinkingMs || 0), 0)
        result.push({
          type: 'orphaned_thinking' as const,
          group: { messages: preThinking, totalMs },
          key: 'orphaned-' + preThinking[0].id
        })
      }
      break
    }
    
    const nextMsg = messages[i]
    
    if (nextMsg.role === 'user') {
      // User message - output any pending thinking first
      if (preThinking.length > 0) {
        const totalMs = preThinking.reduce((sum, m) => sum + (m.thinkingMs || 0), 0)
        result.push({
          type: 'orphaned_thinking' as const,
          group: { messages: preThinking, totalMs },
          key: 'orphaned-' + nextMsg.id
        })
      }
      result.push({
        type: 'user' as const,
        message: nextMsg,
        key: nextMsg.id
      })
      i++
    } else if (nextMsg.role === 'assistant') {
      // Assistant message - attach pre-thinking if exists
      const hasPreThinking = preThinking.length > 0
      const totalMs = hasPreThinking
        ? preThinking.reduce((sum, m) => sum + (m.thinkingMs || 0), 0)
        : 0
      result.push({
        type: 'assistant' as const,
        message: nextMsg,
        preThinking: hasPreThinking ? { messages: preThinking, totalMs } : null,
        key: nextMsg.id
      })
      i++
    }
  }
  
  return result
}


const ThinkingBlock = memo(function ThinkingBlock({ thinking, thinkingDone, thinkingMs }: { thinking: string; thinkingDone: boolean; thinkingMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  const [showTopShadow, setShowTopShadow] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as new thinking tokens arrive.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || thinkingDone) return
    el.scrollTop = el.scrollHeight
    setShowTopShadow(el.scrollTop > 0)
  }, [thinking, thinkingDone])

  // Track scroll position for the top overflow shadow.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setShowTopShadow(el.scrollTop > 0)
    el.addEventListener('scroll', onScroll)
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [thinkingDone])

  if (thinkingDone) {
    return (
      <div className="mb-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs italic text-dim hover:text-muted transition-colors cursor-pointer text-left"
        >
          Thought for {thinkingMs ? formatThinkingDuration(thinkingMs) : 'a moment'}
        </button>
        {expanded && (
          <div className="mt-1 text-xs italic text-dim max-h-[10lh] overflow-y-auto whitespace-pre-wrap">
            {thinking}
          </div>
        )}
      </div>
    )
  }

  // Still streaming — "Thinking…" label above, block quote style with a
  // vertical line, and a top fade shadow when content overflows.
  return (
    <div className="mb-2">
      <div className="text-xs italic text-dim mb-1 flex items-center gap-2">
        <svg className="w-3 h-3 animate-spin text-dim" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Thinking…
      </div>
      <div className="relative">
        {showTopShadow && (
          <div
            className="absolute top-0 left-0 right-0 h-6 pointer-events-none"
            style={{ background: 'linear-gradient(to bottom, var(--surface), transparent)' }}
          />
        )}
        <div
          ref={scrollRef}
          className="text-xs italic text-dim border-l-2 border-line pl-3 max-h-[10lh] overflow-y-auto whitespace-pre-wrap"
        >
          <FadingTail text={thinking} className="text-dim" />
        </div>
      </div>
    </div>
  )
})

/** ConsolidatedThinkingBlock renders multiple thinking blocks as a single collapsed entry.
 *  Custom compare: `group` is rebuilt on every groupMessages pass, but its
 *  message objects keep identity, so unchanged groups skip re-render. */
const sameGroup = (a: ThinkingGroup, b: ThinkingGroup) =>
  a.totalMs === b.totalMs &&
  a.messages.length === b.messages.length &&
  a.messages.every((m, i) => m === b.messages[i])

const ConsolidatedThinkingBlock = memo(function ConsolidatedThinkingBlock({ group }: { group: ThinkingGroup }) {
  const [expanded, setExpanded] = useState(false)
  
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-xs italic text-dim hover:text-muted transition-colors cursor-pointer text-left"
      >
        Thought for {formatThinkingDuration(group.totalMs)}
      </button>
      {expanded && (
        <div className="mt-1 text-xs italic text-dim max-h-[10lh] overflow-y-auto whitespace-pre-wrap">
          {group.messages.map((m, idx) => (
            <div key={m.id} className={idx > 0 ? 'mt-2 border-l-2 border-line pl-3' : ''}>
              {m.thinking}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}, (prev, next) => sameGroup(prev.group, next.group))

/** PreThinkingBlock renders orphaned thinking as a collapsed header. */
const PreThinkingBlock = memo(function PreThinkingBlock({ totalMs, messages }: { totalMs: number; messages: ThinkingGroup['messages'] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-xs italic text-dim hover:text-muted transition-colors cursor-pointer text-left"
      >
        Thought for {formatThinkingDuration(totalMs)}
      </button>
      {expanded && (
        <div className="mt-1 text-xs italic text-dim max-h-[10lh] overflow-y-auto whitespace-pre-wrap">
          {messages.map((m, idx) => (
            <div key={m.id} className={idx > 0 ? 'mt-2 border-l-2 border-line pl-3' : ''}>
              {m.thinking}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}, (prev, next) =>
  prev.totalMs === next.totalMs &&
  prev.messages.length === next.messages.length &&
  prev.messages.every((m, i) => m === next.messages[i]))

/** MessageContent renders an assistant message with optional thinking.
 *  Memoized on primitive props: a block whose message didn't change skips
 *  rendering — including the full markdown re-parse of its text. */
const MessageContent = memo(function MessageContent({ thinking, thinkingDone, thinkingMs, text, streaming }: {
  thinking?: string
  thinkingDone?: boolean
  thinkingMs?: number
  text: string
  streaming?: boolean
}) {
  return (
    <>
      {thinking && thinking.length > 0 && (
        <ThinkingBlock
          thinking={thinking}
          thinkingDone={!!thinkingDone}
          thinkingMs={thinkingMs}
        />
      )}
      {text && (streaming ? <StreamingText text={text} /> : <MemoMarkdown text={text} />)}
    </>
  )
})

export function Chat({ client }: { client: BackendClient }) {
  const messages = useUIState((s) => s.agent.messages)
  const status = useUIState((s) => s.agent.status)
  const busy = status !== 'idle' && status !== 'error'
  // Group messages for consolidation
  const groupedMessages = groupMessages(messages)
  const lastMsg = messages[messages.length - 1]
  
  // Check if there's active thinking (streaming or not yet done)
  const hasActiveThinking = groupedMessages.some(g => {
    if (g.type === 'assistant') {
      return g.message.thinking && !g.message.thinkingDone
    }
    if (g.type === 'orphaned_thinking') {
      return g.group.messages.some(m => m.thinking && !m.thinkingDone)
    }
    return false
  })
  const thinkingActive = hasActiveThinking

  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')

  // Stick to bottom as content streams in — but ONLY while the user is
  // already near the bottom. The previous version forced
  // scrollTop=scrollHeight on every token update unconditionally, so the
  // view fought the scroll position (and yanked it) on every update:
  // that read as flicker while tokens were streaming in.
  const atBottomRef = useRef(true)
  const onScroll = () => {
    const el = chatRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  useEffect(() => {
    const el = chatRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const autoresize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px'
  }

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    atBottomRef.current = true // a new turn always snaps to the bottom
    requestAnimationFrame(autoresize)
    const resp = await client.command(Cmd.AgentStart, { prompt: text })
    if (!resp.ok) {
      console.error('agent.start failed', resp.error)
    }
  }

  const cancel = () => {
    void client.command(Cmd.AgentCancel, {})
  }

  return (
    <>
      <div ref={chatRef} onScroll={onScroll} className="flex flex-col gap-7 text-base max-h-96 md:max-h-none md:flex-1 overflow-y-auto pr-2 pt-2">
        {messages.length === 0 && (
          <div className="text-faint text-sm italic px-2 pt-4">No messages yet — ask the agent anything.</div>
        )}
        {groupedMessages.map((g) => {
          // Handle orphaned thinking blocks (between messages)
          if (g.type === 'orphaned_thinking') {
            return <ConsolidatedThinkingBlock key={g.key} group={g.group} />
          }
          
          // User message
          if (g.type === 'user') {
            const m = g.message
            return (
              <div key={m.id} className="flex justify-end">
                <div className="bg-surface2 text-ink rounded-3xl px-4 py-3 max-w-[85%] whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            )
          }
          
          // Assistant message - may have pre-thinking attached
          if (g.type === 'assistant') {
            const m = g.message
            const { preThinking } = g
            const key = g.key
            
            return (
              <div key={key}>
                {preThinking && preThinking.messages.length > 0 && (
                  <PreThinkingBlock 
                    totalMs={preThinking.totalMs}
                    messages={preThinking.messages}
                  />
                )}
                {m.text && (
                  <MessageContent 
                    thinking={m.thinking}
                    thinkingDone={!!m.thinkingDone}
                    thinkingMs={m.thinkingMs}
                    text={m.text}
                    streaming={m.streaming ?? false}
                  />
                )}
              </div>
            )
          }
          
          return null
        })}
        {busy && !lastMsg?.streaming && !thinkingActive &&
          (status === 'awaiting_tool_approval' ? (
            <span className="text-dim text-sm italic subtle-pulse">
              waiting for your approval…
            </span>
          ) : (
            <span className="text-dim text-sm italic flex items-center gap-2">
              <svg className="w-3.5 h-3.5 animate-spin text-dim" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Generating…
            </span>
          ))}
      </div>

      <form
        className="mt-3 flex items-center gap-2 bg-surface2 rounded-3xl px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder="Ask a follow-up…"
          aria-label="Message the agent"
          onChange={(e) => {
            setDraft(e.target.value)
            autoresize()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            // Shift+Enter inserts a newline.
          }}
          className="flex-1 min-w-0 bg-transparent text-base text-ink placeholder-faint outline-none resize-none leading-loose py-1 overflow-y-auto"
        />
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Stop the agent"
            title="Stop the agent"
            className="w-9 h-9 shrink-0 rounded-full bg-raised hover:bg-danger/80 transition-colors flex items-center justify-center text-mute hover:text-onaccent"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            className="w-9 h-9 shrink-0 rounded-full bg-accent hover:bg-accenthover transition-colors flex items-center justify-center text-onaccent"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        )}
      </form>
    </>
  )
}
