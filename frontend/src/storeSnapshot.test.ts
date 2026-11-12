import { describe, expect, it } from 'vitest'
import { snapshotPatch } from './storeSnapshot'
import { initialState } from './storeState'
import type { ApprovalRequest, SnapshotMessage, ToolCall } from './protocol'

function snap(state: Partial<SnapshotMessage['state']> = {}, seq = 7): SnapshotMessage {
  return {
    type: 'snapshot',
    seq,
    state: {
      agentName: 'Agent',
      agentSlug: 'agent',
      workspace: { path: '/ws', name: 'ws' },
      agent: { status: 'idle', messages: [], toolCalls: [] },
      content: null,
      pendingApprovals: [],
      settingsYaml: '',
      ...state,
    },
  }
}

const approval = (id: string): ApprovalRequest => ({ id, kind: 'bash', title: 'ls' })
const call = (id: string): ToolCall => ({ id, tool: 'read', label: 'read', status: 'done' })

describe('snapshotPatch', () => {
  it('adopts the snapshot wholesale, including the seq', () => {
    const patch = snapshotPatch(initialState, snap({}, 42))
    expect(patch.connected).toBe(true)
    expect(patch.lastBackendSeq).toBe(42)
    expect(patch.agentName).toBe('Agent')
  })

  it('keeps an approval focus that is still pending', () => {
    const prev = { ...initialState, focusedApprovalId: 'a2' }
    const patch = snapshotPatch(prev, snap({ pendingApprovals: [approval('a1'), approval('a2')] }))
    expect(patch.focusedApprovalId).toBe('a2')
  })

  it('replaces a stale approval focus with the first still-pending approval', () => {
    // 'aX' was resolved while we were disconnected; leaving it set would block
    // auto-focus of later approvals forever.
    const prev = { ...initialState, focusedApprovalId: 'aX' }
    const patch = snapshotPatch(prev, snap({ pendingApprovals: [approval('a1'), approval('a2')] }))
    expect(patch.focusedApprovalId).toBe('a1')
  })

  it('keeps a tool-call focus, but only while the call is still in the snapshot', () => {
    const prev = { ...initialState, focusedToolCallId: 't1' }
    const withCall = snapshotPatch(prev, snap({ agent: { status: 'idle', messages: [], toolCalls: [call('t1')] } }))
    expect(withCall.focusedToolCallId).toBe('t1')

    const withoutCall = snapshotPatch(prev, snap())
    expect(withoutCall.focusedToolCallId).toBeNull()
  })

  it('lets a pending approval outrank the tool-call focus', () => {
    const prev = { ...initialState, focusedToolCallId: 't1' }
    const patch = snapshotPatch(prev, snap({
      agent: { status: 'awaiting_tool_approval', messages: [], toolCalls: [call('t1')] },
      pendingApprovals: [approval('a1')],
    }))
    expect(patch.focusedApprovalId).toBe('a1')
    expect(patch.focusedToolCallId).toBeNull()
  })

  it('drops a content pin only when the document is gone', () => {
    const prev = { ...initialState, contentPinned: true }
    expect(snapshotPatch(prev, snap()).contentPinned).toBe(false)
    const withDoc = snapshotPatch(prev, snap({ content: { path: 'a.md', content: '# hi', updatedAt: 1 } }))
    expect(withDoc.contentPinned).toBe(true)
  })
})