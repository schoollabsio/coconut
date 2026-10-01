import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../timeline'
import { buildRailRows } from './Chat'
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
    const keys = rows.filter((row) => row.kind !== 'user').map((row) => row.key)
    const railKeys = rows.filter((row) => row.kind !== 'user').map((row) => row.railKey)

    expect(railKeys).toEqual(keys)
    expect(rows.find((row) => row.kind === 'thinking')?.railKey).toBe('a1-think')
    expect(rows.find((row) => row.kind === 'text')?.railKey).toBe('a2')
  })
})
