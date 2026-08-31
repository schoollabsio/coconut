import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UIStore } from './store'
import type { BackendEvent, SnapshotMessage } from './protocol'
import { Ev, Stream } from './protocol'

// Node has no rAF; flush synchronously-ish in tests.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
})

function ev(seq: number, name: string, payload?: unknown): BackendEvent {
  return { type: 'event', seq, name, payload, timestamp: Date.now() }
}

function snap(seq: number): SnapshotMessage {
  return {
    type: 'snapshot',
    seq,
    state: {
      agentName: 'Restored Agent',
      agentSlug: 'restored-agent',
      workspace: { path: '/ws', name: 'ws' },
      agent: {
        status: 'idle',
        messages: [{ id: 'm1', role: 'user', text: 'hi' }],
        toolCalls: [],
      },
      content: null,
      pendingApprovals: [],
      settingsYaml: 'provider: anthropic\n',
    },
  }
}

describe('UIStore', () => {
  it('applies a snapshot as the state baseline', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(10))
    expect(s.state.agentName).toBe('Restored Agent')
    expect(s.state.lastBackendSeq).toBe(10)
    expect(s.state.connected).toBe(true)
    expect(s.state.agent.messages).toHaveLength(1)
    expect(s.state.settingsYaml).toContain('anthropic')
  })

  it('applies sequenced events in order', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentStatusChanged, { status: 'thinking' }))
    expect(s.state.agent.status).toBe('thinking')
    expect(s.state.lastBackendSeq).toBe(2)
  })

  it('ignores duplicate/replayed events', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(5))
    s.applyBackendMessage(ev(5, Ev.AgentStatusChanged, { status: 'error' }))
    expect(s.state.agent.status).toBe('idle')
  })

  it('requests a resync on a sequence gap instead of applying', () => {
    const s = new UIStore()
    const resync = vi.fn()
    s.resync = resync
    s.applyBackendMessage(snap(3))
    s.applyBackendMessage(ev(9, Ev.AgentStatusChanged, { status: 'error' }))
    expect(resync).toHaveBeenCalledOnce()
    expect(s.state.agent.status).toBe('idle') // not applied
    expect(s.state.lastBackendSeq).toBe(3)
  })

  it('replaces the streaming message when its final version arrives', async () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hel' } })
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hello' } })
    await new Promise((r) => setTimeout(r, 5)) // let the rAF flush land
    let msgs = s.state.agent.messages
    expect(msgs.filter((m) => m.id === 'm9')).toHaveLength(1)
    expect(msgs.find((m) => m.id === 'm9')?.text).toBe('hello')
    expect(msgs.find((m) => m.id === 'm9')?.streaming).toBe(true)

    s.applyBackendMessage(ev(2, Ev.AgentMessage, { id: 'm9', role: 'assistant', text: 'hello' }))
    msgs = s.state.agent.messages
    expect(msgs.filter((m) => m.id === 'm9')).toHaveLength(1)
    expect(msgs.find((m) => m.id === 'm9')?.streaming).toBeUndefined()
  })

  it('tracks approvals: focus on request, clear on resolve', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentToolStarted, { id: 'c1', tool: 'propose_edit', label: 'Edit foo.ts', status: 'running' }))
    const approval = { id: 'ap-1', kind: 'propose_edit', title: 'Edit foo.ts', path: 'foo.ts', what: 'w', why: 'y', diff: '+x' }
    s.applyBackendMessage(ev(3, Ev.ApprovalRequested, approval))
    expect(s.state.pendingApprovals).toHaveLength(1)
    expect(s.state.focusedApprovalId).toBe('ap-1')
    expect(s.state.agent.status).toBe('awaiting_approval')
    expect(s.state.agent.toolCalls[0].status).toBe('pending_approval')

    s.applyBackendMessage(ev(4, Ev.ApprovalResolved, { approvalId: 'ap-1', decision: 'allow' }))
    expect(s.state.pendingApprovals).toHaveLength(0)
    expect(s.state.focusedApprovalId).toBeNull()
    expect(s.state.agent.status).toBe('thinking')
  })

  it('updates content on content.updated', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.ContentUpdated, { path: 'content.md', content: '# Hi', updatedAt: 1 }))
    expect(s.state.content?.path).toBe('content.md')
  })
})
