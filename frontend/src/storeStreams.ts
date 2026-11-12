/**
 * Stream application (PLAN.md §10.2). Tokens and thinking arrive as
 * cumulative payloads, unsequenced and coalesced into one flush per animation
 * frame, so both branches must tolerate landing *after* the finalizing event:
 * a finalized message id or a terminal status is never revived.
 */
import { Stream } from './protocol'
import type { ThinkingPayload } from './protocol'
import type { EventCtx } from './storeEvents'

interface TextStreamPayload {
  messageId: string
  text: string
}

/** Apply one coalesced stream payload; unknown stream names are ignored. */
export function applyStreamPayload(ctx: EventCtx, name: string, payload: unknown): void {
  if (name === Stream.AgentThinking) applyThinking(ctx, payload as ThinkingPayload)
  else if (name === Stream.AgentToken) applyToken(ctx, payload as TextStreamPayload)
}

function applyThinking(ctx: EventCtx, { messageId, text }: ThinkingPayload): void {
  if (ctx.finalized.has(messageId)) return // late flush after finalization
  const messages = [...ctx.state.agent.messages]
  const idx = messages.findIndex((m) => m.id === messageId)
  // Preserve thinkingDone if the completed event already set it (events apply
  // synchronously; streams are RAF-buffered).
  if (idx >= 0) messages[idx] = { ...messages[idx], thinking: text }
  else messages.push({ id: messageId, role: 'assistant', text: '', thinking: text, thinkingDone: false })
  // Status stays put: thinking is the 'reasoning' phase, parallel to text
  // streaming which flips to 'generating'.
  ctx.setAgent({ messages })
}

function applyToken(ctx: EventCtx, { messageId, text }: TextStreamPayload): void {
  const { status } = ctx.state.agent
  // A RAF-buffered token stream can flush *after* agent.completed fires
  // (streams are unsequenced; events are processed synchronously). Guard
  // against re-activating a terminal state: don't reset status to 'generating'
  // or re-mark a finalized message as streaming.
  if (status === 'idle' || status === 'error') return
  if (ctx.finalized.has(messageId)) return // late flush after finalization
  const messages = [...ctx.state.agent.messages]
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx >= 0) {
    messages[idx] = { ...messages[idx], text, streaming: true }
  } else {
    messages.push({ id: messageId, role: 'assistant', text, streaming: true })
  }
  ctx.setAgent({ status: 'generating', messages })
}
