import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline'
import { buildRailRows, type RenderRow } from './chat/chatUtils'
import type { ChatMessage } from '../protocol'

const user = (id: string, seq: number, text: string): ChatMessage => ({ id, seq, role: 'user', text })
const assistant = (id: string, seq: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  seq,
  role: 'assistant',
  text,
  ...extra,
})

describe('buildRailRows', () => {
  it('keeps every non-user row keyed consistently for rail measurement', () => {
    const timeline = buildTimeline(
      [
        user('u1', 1, 'hi'),
        assistant('a1', 2, '', { thinking: 'pondering', thinkingDone: true, thinkingMs: 1200 }),
        assistant('a2', 3, 'answer'),
      ],
      [],
    )

    const rows = buildRailRows(timeline, new Set())
    const keyed = rows.filter(
      (row): row is Exclude<RenderRow, { kind: 'user' }> => row.kind !== 'user',
    )

    expect(keyed.map((row) => row.railKey)).toEqual(keyed.map((row) => row.key))
    expect(keyed.find((row) => row.kind === 'thinking')?.railKey).toBe('a1-think')
    expect(keyed.find((row) => row.kind === 'text')?.railKey).toBe('a2')
  })
})
