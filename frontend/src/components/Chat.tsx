import { useEffect, useRef, useState } from 'react'
import { ChatMessage } from '../protocol'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { useUIState } from '../store'
import { Markdown } from './Markdown'
import { FadingTail, StreamingText } from './StreamingText'

type ThinkingGroup = {
  messages: ChatMessage[]
  totalMs: number
}

type GroupedMessage = 
  | { type: 'consolidated'; group: ThinkingGroup; key: string }
  | { type: 'single'; message: ChatMessage; key: string }

const MAX_INPUT_HEIGHT = 160

function formatThinkingDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
  const mins = Math.round(secs / 60)
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
}

/** Check if a message is "thinking-only" (assistant message with thinking but no text). */
function isThinkingOnly(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    !!m.thinking &&
    m.thinking.length > 0 &&
    m.thinkingDone === true &&
    (!m.text || m.text.length === 0)
  )
}

/** Group consecutive thinking-only messages for consolidation. */
function groupMessages(messages: ChatMessage[]): GroupedMessage[] {
  const result: GroupedMessage[] = []
  let i = 0
  
  while (i < messages.length) {
    if (isThinkingOnly(messages[i])) {
      const group: ChatMessage[] = []
      let totalMs = 0
      while (i < messages.length && isThinkingOnly(messages[i])) {
        group.push(messages[i])
        totalMs += messages[i].thinkingMs || 0
        i++
      }
      result.push({
        type: 'consolidated' as const,
        group: { messages: group, totalMs },
        key: group[0].id + '-thinking'
      })
    } else {
      const m = messages[i]
      result.push({
        type: 'single' as const,
        message: m,
        key: m.id
      })
      i++
    }
  }
  
  return result
}

function ThinkingBlock({ thinking, thinkingDone, thinkingMs }: { thinking: string; thinkingDone: boolean; thinkingMs?: number }) {
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
}

/** ConsolidatedThinkingBlock renders multiple thinking blocks as a single collapsed entry. */
function ConsolidatedThinkingBlock({ group }: { group: ThinkingGroup }) {
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
}

export function Chat({ client }: { client: BackendClient }) {
  const messages = useUIState((s) => s.agent.messages)
  const status = useUIState((s) => s.agent.status)
  const busy = status !== 'idle' && status !== 'error'
  // Group messages for consolidation
  const groupedMessages = groupMessages(messages)
  const lastMsg = messages[messages.length - 1]
  
  // Check if there's active thinking (streaming or not yet done)
  const hasActiveThinking = groupedMessages.some(g => 
    g.type === 'single' && g.message.thinking && !g.message.thinkingDone
  ) || 
  groupedMessages.some(g => 
    g.type === 'consolidated' && g.group.messages.some(m => m.thinking && !m.thinkingDone)
  )
  const thinkingActive = hasActiveThinking

  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')

  // Stick to bottom as content streams in.
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
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
      <div ref={chatRef} className="flex flex-col gap-7 text-base max-h-96 md:max-h-none md:flex-1 overflow-y-auto pr-2 pt-2">
        {messages.length === 0 && (
          <div className="text-faint text-sm italic px-2 pt-4">No messages yet — ask the agent anything.</div>
        )}
        {groupedMessages.map((g) => {
          if (g.type === 'consolidated') {
            return <ConsolidatedThinkingBlock key={g.key} group={g.group} />
          }
          
          const m = g.message
          
          // User message - render with right alignment
          if (m.role === 'user') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="bg-surface2 text-ink rounded-3xl px-4 py-3 max-w-[85%] whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            )
          }
          
          // Assistant message (single or with text)
          return (
            <div key={g.key}>
              {m.thinking && m.thinking.length > 0 && (
                <ThinkingBlock
                  thinking={m.thinking}
                  thinkingDone={!!m.thinkingDone}
                  thinkingMs={m.thinkingMs}
                />
              )}
              {m.text && (m.streaming ? <StreamingText text={m.text} /> : <Markdown text={m.text} />)}
            </div>
          )
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
