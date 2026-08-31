import { memo, useRef } from 'react'
import { Markdown } from './Markdown'

const MemoMarkdown = memo(Markdown)

/**
 * StreamingText renders an in-progress assistant message.
 *
 * The committed portion (everything up to the last newline) goes through
 * the memoized markdown renderer — it re-parses once per completed line
 * instead of once per token. The current partial line renders as raw text
 * split into arrival chunks, each wrapped in a span that plays the
 * per-token fade-in exactly once (CSS animations cannot target text nodes,
 * so spans are the unit of animation).
 *
 * When the stream ends the caller swaps this for a plain <Markdown>,
 * settling the final line into fully formatted markdown.
 */
export function StreamingText({ text }: { text: string }) {
  const lastNl = text.lastIndexOf('\n')
  const committed = lastNl >= 0 ? text.slice(0, lastNl + 1) : ''
  const tail = lastNl >= 0 ? text.slice(lastNl + 1) : text
  return (
    <>
      {committed && <MemoMarkdown text={committed} />}
      <FadingTail text={tail} />
    </>
  )
}

export interface FadeChunk {
  id: number
  text: string
}

/** diffChunks computes the new chunk list as streamed text grows.
 *  Pure (exported for tests): pass the previous rendered text, the previous
 *  chunks, the next text, and the id to assign to a fresh chunk. */
export function diffChunks(prevText: string, prevChunks: FadeChunk[], nextText: string, nextId: number): FadeChunk[] {
  if (nextText === prevText) return prevChunks
  if (nextText.startsWith(prevText)) {
    const added = nextText.slice(prevText.length)
    return [...prevChunks, { id: nextId, text: added }]
  }
  // Text was replaced rather than appended (message swap/reset): start over
  // with a single chunk.
  return [{ id: nextId, text: nextText }]
}

function FadingTail({ text }: { text: string }) {
  const state = useRef<{ text: string; chunks: FadeChunk[]; counter: number }>({ text: '', chunks: [], counter: 0 })
  const s = state.current
  if (text !== s.text) {
    s.chunks = diffChunks(s.text, s.chunks, text, ++s.counter)
    s.text = text
  }
  return (
    <span className="whitespace-pre-wrap">
      {s.chunks.map((c) => (
        <span key={c.id} className="token-fade">
          {c.text}
        </span>
      ))}
    </span>
  )
}
