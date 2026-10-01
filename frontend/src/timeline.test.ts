import { describe, expect, it } from 'vitest'
import { buildTimeline } from './timeline'
import type { ChatMessage, ToolCall } from './protocol'

function user(id: string, seq: number, text: string): ChatMessage {
  return { id, seq, role: 'user', text }
}

function assistantText(id: string, seq: number | undefined, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, seq, role: 'assistant', text, ...extra }
}

function toolCall(id: string, seq: number, tool: string, label: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, seq, tool, label, status: 'done', ...extra }
}

describe('buildTimeline', () => {
  it('interleaves messages and tool calls chronologically by seq', () => {
    const timeline = buildTimeline(
      [
        user('m1', 1, 'hi'),
        assistantText('m3', 4, 'done'),
      ],
      [toolCall('c1', 2, 'run', 'Run shell'), toolCall('c2', 3, 'run', 'Run shell')],
    )

    expect(timeline.map((entry) => entry.kind)).toEqual(['user', 'tool', 'tool', 'text'])
    expect(timeline.map((entry) => entry.key)).toEqual(['m1', 'c1', 'c2', 'm3'])
  })

  it('splits an assistant message with thinking and text into two entries', () => {
    const message = assistantText('m1', 7, 'final answer', { thinking: 'pondering' })
    const timeline = buildTimeline([message], [])

    expect(timeline).toHaveLength(2)
    expect(timeline.map((entry) => entry.kind)).toEqual(['thinking', 'text'])
    expect(timeline.map((entry) => entry.key)).toEqual(['m1-think', 'm1'])
    expect(timeline[0].kind === 'thinking' ? timeline[0].message : null).toBe(message)
    expect(timeline[1].kind === 'text' ? timeline[1].message : null).toBe(message)
  })

  it('renders thinking-only and text-only assistant messages', () => {
    const timeline = buildTimeline(
      [
        assistantText('m1', 1, '', { thinking: 'pondering' }),
        assistantText('m2', 2, 'just text'),
      ],
      [],
    )

    expect(timeline.map((entry) => entry.kind)).toEqual(['thinking', 'text'])
    expect(timeline.map((entry) => entry.key)).toEqual(['m1-think', 'm2'])
  })

  it("sorts seq-less streaming messages after seq'd items and preserves their relative order", () => {
    const timeline = buildTimeline(
      [
        assistantText('m1', undefined, '', { thinking: 'live thought' }),
        assistantText('m2', undefined, 'live text', { streaming: true }),
      ],
      [toolCall('c1', 1, 'run', 'Run shell')],
    )

    expect(timeline.map((entry) => entry.kind)).toEqual(['tool', 'thinking', 'text'])
    expect(timeline.map((entry) => entry.key)).toEqual(['c1', 'm1-think', 'm2'])
  })

  it('collapses consecutive read calls and agent-labeled runs into group entries', () => {
    const readTimeline = buildTimeline([], [toolCall('r1', 1, 'read', 'Read file'), toolCall('r2', 2, 'read', 'Read file')])
    expect(readTimeline).toHaveLength(1)
    expect(readTimeline[0].kind).toBe('group')
    if (readTimeline[0].kind === 'group') {
      expect(readTimeline[0].group.grouper).toBe('read')
      expect(readTimeline[0].group.toolCalls.map((call) => call.id)).toEqual(['r1', 'r2'])
      expect(readTimeline[0].key).toBe(readTimeline[0].group.key)
    }

    const agentTimeline = buildTimeline(
      [],
      [
        toolCall('a1', 3, 'grep', 'Search', { groupLabel: 'Read Files' }),
        toolCall('a2', 4, 'read', 'Read file', { groupLabel: 'read_files' }),
      ],
    )
    expect(agentTimeline).toHaveLength(1)
    expect(agentTimeline[0].kind).toBe('group')
    if (agentTimeline[0].kind === 'group') {
      expect(agentTimeline[0].group.grouper).toBe('agent')
      expect(agentTimeline[0].group.toolCalls.map((call) => call.id)).toEqual(['a1', 'a2'])
    }
  })

  it('splits a tool group when a message lands between calls', () => {
    const timeline = buildTimeline(
      [user('m1', 2, 'interrupt')],
      [toolCall('r1', 1, 'read', 'Read file'), toolCall('r2', 3, 'read', 'Read file')],
    )

    expect(timeline.map((entry) => entry.kind)).toEqual(['tool', 'user', 'tool'])
    expect(timeline.map((entry) => entry.key)).toEqual(['r1', 'm1', 'r2'])
  })

  it('handles empty inputs and snapshot-restored arrays in seq order', () => {
    expect(buildTimeline([], [])).toEqual([])

    const timeline = buildTimeline(
      [user('m1', 1, 'hello'), assistantText('m4', 4, 'done')],
      [toolCall('c1', 2, 'run', 'Run shell'), toolCall('c2', 3, 'write', 'Write file')],
    )

    expect(timeline.map((entry) => entry.key)).toEqual(['m1', 'c1', 'c2', 'm4'])
    expect(timeline.map((entry) => entry.kind)).toEqual(['user', 'tool', 'tool', 'text'])
  })
})
