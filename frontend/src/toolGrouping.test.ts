import { describe, it, expect } from 'vitest'
import type { ToolCall } from './protocol'
import { groupToolCalls, readGrouper, agentGrouper, defaultGroupers } from './toolGrouping'

function tc(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'c1',
    tool: 'read',
    label: 'Read App.tsx',
    status: 'done',
    ...overrides,
  }
}

function reads(n: number, startId: number = 1): ToolCall[] {
  return Array.from({ length: n }, (_, i) =>
    tc({ id: `c${startId + i}`, tool: 'read', label: `Read file${i + 1}.ts` }),
  )
}

function edit(id: string, label: string): ToolCall {
  return tc({ id, tool: 'edit', label })
}

describe('groupToolCalls', () => {
  it('returns empty for no tool calls', () => {
    expect(groupToolCalls([])).toEqual([])
  })

  it('returns a singlet for a single read', () => {
    const result = groupToolCalls([tc({ id: 'c1', label: 'Read App.tsx' })])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBeNull()
    expect(result[0].toolCalls).toHaveLength(1)
  })

  it('groups two consecutive reads', () => {
    const result = groupToolCalls(reads(2))
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('read')
    expect(result[0].label).toBe('Read 2 files')
    expect(result[0].toolCalls).toHaveLength(2)
    expect(result[0].key).toBe('read-c1')
  })

  it('groups three consecutive reads', () => {
    const result = groupToolCalls(reads(3))
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Read 3 files')
    expect(result[0].toolCalls).toHaveLength(3)
  })

  it('breaks groups when a non-read tool interrupts', () => {
    const result = groupToolCalls([
      ...reads(2, 1),
      edit('c3', 'Edit TodoList.tsx'),
      ...reads(2, 4),
    ])
    expect(result).toHaveLength(3)
    expect(result[0].grouper).toBe('read')
    expect(result[0].label).toBe('Read 2 files')
    expect(result[1].grouper).toBeNull()
    expect(result[1].label).toBe('Edit TodoList.tsx')
    expect(result[2].grouper).toBe('read')
    expect(result[2].label).toBe('Read 2 files')
  })

  it('does not group non-read tools', () => {
    const result = groupToolCalls([
      edit('c1', 'Edit A.tsx'),
      edit('c2', 'Edit B.tsx'),
    ])
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.grouper === null)).toBe(true)
  })

  it('handles a realistic mixed sequence (like todo-app)', () => {
    const result = groupToolCalls([
      tc({ id: 'call_1', tool: 'read', label: 'Read App.tsx' }),
      tc({ id: 'call_2', tool: 'read', label: 'Read TodoList.tsx' }),
      tc({ id: 'call_3', tool: 'propose_edit', label: 'Edit TodoList.tsx' }),
      tc({ id: 'call_4', tool: 'show_content', label: 'Show content.md' }),
    ])
    expect(result).toHaveLength(3)
    expect(result[0].grouper).toBe('read')
    expect(result[0].label).toBe('Read 2 files')
    expect(result[1].grouper).toBeNull()
    expect(result[2].grouper).toBeNull()
  })

  it('preserves group key stability when a third read is appended', () => {
    const two = groupToolCalls(reads(2))
    expect(two[0].key).toBe('read-c1')

    const three = groupToolCalls(reads(3))
    expect(three[0].key).toBe('read-c1')
  })

  it('does not group a single read between non-reads', () => {
    const result = groupToolCalls([
      edit('c1', 'Edit A'),
      tc({ id: 'c2', tool: 'read', label: 'Read B' }),
      edit('c3', 'Edit C'),
    ])
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.grouper === null)).toBe(true)
  })

  it('handles a long run of reads', () => {
    const result = groupToolCalls(reads(10))
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Read 10 files')
    expect(result[0].toolCalls).toHaveLength(10)
  })

  it('handles reads followed by reads at the end', () => {
    const result = groupToolCalls([
      edit('c1', 'Edit A'),
      ...reads(3, 2),
    ])
    expect(result).toHaveLength(2)
    expect(result[1].grouper).toBe('read')
    expect(result[1].label).toBe('Read 3 files')
  })
})

describe('readGrouper', () => {
  it('isRelevant returns true for 2+ consecutive reads', () => {
    expect(readGrouper.isRelevant(reads(2), 0, null)).toBe(true)
    expect(readGrouper.isRelevant(reads(3), 0, null)).toBe(true)
  })

  it('isRelevant returns false for a single read', () => {
    expect(readGrouper.isRelevant(reads(1), 0, null)).toBe(false)
  })

  it('isRelevant returns false for non-read tools', () => {
    expect(readGrouper.isRelevant([edit('c1', 'Edit X')], 0, null)).toBe(false)
  })

  it('isRelevant returns false when not enough reads remain at position', () => {
    // [read, read, edit, read] — index 3 has only 1 read
    const calls = [...reads(2, 1), edit('c3', 'Edit'), tc({ id: 'c4' })]
    expect(readGrouper.isRelevant(calls, 0, null)).toBe(true)
    expect(readGrouper.isRelevant(calls, 2, null)).toBe(false)
    expect(readGrouper.isRelevant(calls, 3, null)).toBe(false)
  })

  it('formGroup produces correct label, key, and toolCalls', () => {
    const group = readGrouper.formGroup(reads(3), 0, null)
    expect(group.label).toBe('Read 3 files')
    expect(group.key).toBe('read-c1')
    expect(group.grouper).toBe('read')
    expect(group.toolCalls).toHaveLength(3)
  })
})

describe('agentGrouper', () => {
  it('groups two consecutive calls with the same groupLabel', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'read-all' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B', groupLabel: 'read-all' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('agent')
    expect(result[0].label).toBe('read-all')
    expect(result[0].toolCalls).toHaveLength(2)
    expect(result[0].key).toBe('agent-read-all-c1')
  })

  it('does not group a single call with a groupLabel (singleton)', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'read-all' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBeNull()
  })

  it('groups consecutive calls with different tool types', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'investigate' }),
      tc({ id: 'c2', tool: 'grep', label: 'Grep pattern', groupLabel: 'investigate' }),
      tc({ id: 'c3', tool: 'propose_edit', label: 'Edit A', groupLabel: 'investigate' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('agent')
    expect(result[0].label).toBe('investigate')
    expect(result[0].toolCalls).toHaveLength(3)
  })

  it('normalizes groupLabel for matching (typos, casing, punctuation)', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'Read_Files!' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B', groupLabel: 'read files' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('agent')
    // Display uses the raw first-seen label
    expect(result[0].label).toBe('Read_Files!')
    // Key uses the normalized form
    expect(result[0].key).toBe('agent-read-files-c1')
  })

  it('breaks groups when a non-matching call interrupts', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'g1' }),
      tc({ id: 'c2', tool: 'edit', label: 'Edit B', groupLabel: 'g2' }),
      tc({ id: 'c3', tool: 'read', label: 'Read C', groupLabel: 'g1' }),
    ])
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.grouper === null)).toBe(true)
  })

  it('falls through to readGrouper when no groupLabel is present', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('read')
  })

  it('agentGrouper takes priority over readGrouper', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: 'batch-1' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B', groupLabel: 'batch-1' }),
      tc({ id: 'c3', tool: 'read', label: 'Read C', groupLabel: 'batch-1' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('agent')
    expect(result[0].label).toBe('batch-1')
  })

  it('handles groupLabel that normalizes to empty (falls through)', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: '---' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B', groupLabel: '---' }),
    ])
    // Normalizes to empty → agentGrouper skips → readGrouper claims them
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('read')
  })

  it('preserves key stability when calls are appended', () => {
    const two = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'A', groupLabel: 'g' }),
      tc({ id: 'c2', tool: 'read', label: 'B', groupLabel: 'g' }),
    ])
    expect(two[0].key).toBe('agent-g-c1')

    const three = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'A', groupLabel: 'g' }),
      tc({ id: 'c2', tool: 'read', label: 'B', groupLabel: 'g' }),
      tc({ id: 'c3', tool: 'read', label: 'C', groupLabel: 'g' }),
    ])
    expect(three[0].key).toBe('agent-g-c1')
  })

  it('treats _default sentinel as no label, falling through to readGrouper', () => {
    const result = groupToolCalls([
      tc({ id: 'c1', tool: 'read', label: 'Read A', groupLabel: '_default' }),
      tc({ id: 'c2', tool: 'read', label: 'Read B', groupLabel: '_default' }),
      tc({ id: 'c3', tool: 'read', label: 'Read C', groupLabel: '_default' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].grouper).toBe('read')
    expect(result[0].label).toBe('Read 3 files')
  })
})

describe('defaultGroupers', () => {
  it('includes agentGrouper as the first grouper, then readGrouper', () => {
    expect(defaultGroupers[0]).toBe(agentGrouper)
    expect(defaultGroupers[1]).toBe(readGrouper)
    expect(defaultGroupers).toHaveLength(2)
  })
})
