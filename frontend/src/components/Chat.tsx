import { useEffect, useRef, useState } from 'react'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { useUIState } from '../store'
import { Markdown } from './Markdown'
import { StreamingText } from './StreamingText'

const MAX_INPUT_HEIGHT = 160

export function Chat({ client }: { client: BackendClient }) {
  const messages = useUIState((s) => s.agent.messages)
  const status = useUIState((s) => s.agent.status)
  const busy = status !== 'idle' && status !== 'error'

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
      <div ref={chatRef} className="flex flex-col gap-6 text-sm max-h-96 md:max-h-none md:flex-1 overflow-y-auto pr-2 pt-2">
        {messages.length === 0 && (
          <div className="text-gray-600 text-xs italic px-2 pt-4">No messages yet — ask the agent anything.</div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="bg-gray-800 text-gray-100 rounded-3xl px-4 py-2.5 max-w-[85%] whitespace-pre-wrap">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex gap-3">
              <span className="bg-gradient-to-br from-blue-400 to-purple-400 bg-clip-text text-transparent select-none mt-0.5">
                ✦
              </span>
              <div className="min-w-0 flex-1">
                {m.streaming ? <StreamingText text={m.text} /> : <Markdown text={m.text} />}
                {m.streaming && <span className="text-gray-500 animate-pulse">▍</span>}
              </div>
            </div>
          ),
        )}
        {busy && !messages[messages.length - 1]?.streaming && (
          <div className="flex gap-3">
            <span className="bg-gradient-to-br from-blue-400 to-purple-400 bg-clip-text text-transparent select-none mt-0.5">
              ✦
            </span>
            <span className="text-gray-500 text-xs italic">
              {status === 'awaiting_approval' ? 'waiting for your approval…' : 'working…'}
            </span>
          </div>
        )}
      </div>

      <form
        className="mt-3 flex items-start gap-2 bg-gray-800 rounded-3xl px-4 py-2"
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
          className="flex-1 min-w-0 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none resize-none leading-relaxed py-1 overflow-y-auto"
        />
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Stop the agent"
            title="Stop the agent"
            className="w-8 h-8 shrink-0 rounded-full bg-gray-700 hover:bg-red-500/80 transition-colors flex items-center justify-center text-gray-300 hover:text-white"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            className="w-8 h-8 shrink-0 rounded-full bg-blue-500 hover:bg-blue-400 transition-colors flex items-center justify-center text-white"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        )}
      </form>
    </>
  )
}
