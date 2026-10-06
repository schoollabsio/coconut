import { describe, expect, it } from 'vitest'
import { resolvePanelView } from './panelView'
import type { ApprovalRequest, ContentDoc, ToolCall } from './protocol'

const approval: ApprovalRequest = { id: 'ap-1', kind: 'bash', title: 'Run make x', command: 'make x' }
const doc: ContentDoc = { path: 'a.md', content: '# A', updatedAt: 1 }
const call: ToolCall = { id: 'tc-1', tool: 'run', label: 'Run make x', status: 'running' }

function state(over: Partial<Parameters<typeof resolvePanelView>[0]> = {}) {
  return {
    focusedApprovalId: null,
    focusedToolCallId: null,
    contentPinned: false,
    content: null,
    pendingApprovals: [] as ApprovalRequest[],
    toolCalls: [] as ToolCall[],
    ...over,
  }
}

describe('resolvePanelView', () => {
  it('is empty with nothing to show', () => {
    expect(resolvePanelView(state()).kind).toBe('empty')
  })

  it('shows the latest content when nothing competes', () => {
    const v = resolvePanelView(state({ content: doc }))
    expect(v).toEqual({ kind: 'content', doc })
  })

  it('a pending approval beats content via the fallback', () => {
    const v = resolvePanelView(state({ content: doc, pendingApprovals: [approval] }))
    expect(v).toEqual({ kind: 'approval', approval })
  })

  it('pinned content beats the pending-approval fallback', () => {
    // The core of the browse-while-pending feature: the user picked a
    // library entry, so content wins even though an approval is waiting.
    const v = resolvePanelView(state({ content: doc, contentPinned: true, pendingApprovals: [approval] }))
    expect(v).toEqual({ kind: 'content', doc })
  })

  it('an explicitly focused approval beats pinned content', () => {
    const v = resolvePanelView(
      state({ content: doc, contentPinned: true, pendingApprovals: [approval], focusedApprovalId: 'ap-1' }),
    )
    expect(v).toEqual({ kind: 'approval', approval })
  })

  it('a focused tool call beats content but loses to an approval', () => {
    const v = resolvePanelView(state({ content: doc, toolCalls: [call], focusedToolCallId: 'tc-1' }))
    expect(v).toEqual({ kind: 'tool', call })

    const v2 = resolvePanelView(
      state({ content: doc, toolCalls: [call], focusedToolCallId: 'tc-1', pendingApprovals: [approval] }),
    )
    // Tool focus still wins: the fallback approval only fires when nothing
    // is focused and nothing is pinned.
    expect(v2).toEqual({ kind: 'tool', call })
  })

  it('ignores dangling focus ids', () => {
    const v = resolvePanelView(state({ content: doc, focusedApprovalId: 'gone', focusedToolCallId: 'gone' }))
    expect(v).toEqual({ kind: 'content', doc })
  })
})
