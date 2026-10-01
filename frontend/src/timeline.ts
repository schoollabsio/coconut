import type { ChatMessage, ToolCall } from './protocol'
import { groupToolCalls, type ToolCallGroup } from './toolGrouping'

export type TimelineEntry =
  | { kind: 'user'; message: ChatMessage; key: string }
  | { kind: 'thinking'; message: ChatMessage; key: string }
  | { kind: 'text'; message: ChatMessage; key: string }
  | { kind: 'tool'; call: ToolCall; key: string }
  | { kind: 'group'; group: ToolCallGroup; key: string }

type TimelineAtom =
  | { kind: 'message'; message: ChatMessage; seq?: number; index: number }
  | { kind: 'tool'; call: ToolCall; seq?: number; index: number }

function compareAtoms(a: TimelineAtom, b: TimelineAtom): number {
  const aSeq = a.seq
  const bSeq = b.seq
  const aHasSeq = aSeq !== undefined
  const bHasSeq = bSeq !== undefined

  if (aHasSeq && bHasSeq) {
    if (aSeq !== bSeq) return aSeq - bSeq
    return 0
  }
  if (aHasSeq !== bHasSeq) return aHasSeq ? -1 : 1

  if (a.kind !== b.kind) return a.kind === 'message' ? -1 : 1
  return a.index - b.index
}

function pushMessageEntries(entries: TimelineEntry[], message: ChatMessage): void {
  if (message.role === 'user') {
    entries.push({ kind: 'user', message, key: message.id })
    return
  }

  const hasThinking = Boolean(message.thinking)
  const hasText = message.text.length > 0

  if (hasThinking) {
    entries.push({ kind: 'thinking', message, key: `${message.id}-think` })
  }
  if (hasText || !hasThinking) {
    entries.push({ kind: 'text', message, key: message.id })
  }
}

function pushToolRun(entries: TimelineEntry[], run: ToolCall[]): void {
  if (run.length === 0) return
  const grouped = groupToolCalls(run)
  for (const group of grouped) {
    if (group.toolCalls.length === 1) {
      const call = group.toolCalls[0]
      entries.push({ kind: 'tool', call, key: call.id })
      continue
    }
    entries.push({ kind: 'group', group, key: group.key })
  }
}

export function buildTimeline(messages: ChatMessage[], toolCalls: ToolCall[]): TimelineEntry[] {
  const atoms: TimelineAtom[] = [
    ...messages.map((message, index): TimelineAtom => ({ kind: 'message', message, seq: message.seq, index })),
    ...toolCalls.map((call, index): TimelineAtom => ({ kind: 'tool', call, seq: call.seq, index })),
  ]

  atoms.sort(compareAtoms)

  const entries: TimelineEntry[] = []
  let pendingTools: ToolCall[] = []

  for (const atom of atoms) {
    if (atom.kind === 'tool') {
      pendingTools.push(atom.call)
      continue
    }

    pushToolRun(entries, pendingTools)
    pendingTools = []
    pushMessageEntries(entries, atom.message)
  }

  pushToolRun(entries, pendingTools)
  return entries
}
