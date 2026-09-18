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
    s.applyBackendMessage(ev(2, Ev.AgentStatusChanged, { status: 'reasoning' }))
    expect(s.state.agent.status).toBe('reasoning')
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
    // In the real flow, agent.started moves status off 'idle' before any
    // token streams are emitted (the late-stream guard drops streams while
    // the agent is idle/error).
    s.applyBackendMessage(ev(2, Ev.AgentStarted))
    s.applyBackendMessage(ev(3, Ev.AgentStatusChanged, { status: 'reasoning' }))
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hel' } })
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hello' } })
    await new Promise((r) => setTimeout(r, 5)) // let the rAF flush land
    let msgs = s.state.agent.messages
    expect(msgs.filter((m) => m.id === 'm9')).toHaveLength(1)
    expect(msgs.find((m) => m.id === 'm9')?.text).toBe('hello')
    expect(msgs.find((m) => m.id === 'm9')?.streaming).toBe(true)

    s.applyBackendMessage(ev(4, Ev.AgentMessage, { id: 'm9', role: 'assistant', text: 'hello' }))
    msgs = s.state.agent.messages
    expect(msgs.filter((m) => m.id === 'm9')).toHaveLength(1)
    expect(msgs.find((m) => m.id === 'm9')?.streaming).toBeUndefined()
  })

  it('drops late token streams after finalization, before agent.completed (end-of-message flicker)', async () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentStarted))
    s.applyBackendMessage(ev(3, Ev.AgentStatusChanged, { status: 'reasoning' }))
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hello' } })
    await new Promise((r) => setTimeout(r, 5))
    expect(s.state.agent.messages.find((m) => m.id === 'm9')?.streaming).toBe(true)

    // The message finalizes, but the run is not yet settled (no
    // agent.completed), so the status guard alone does not cover this.
    s.applyBackendMessage(ev(4, Ev.AgentMessage, { id: 'm9', role: 'assistant', text: 'hello' }))
    s.applyBackendMessage(ev(5, Ev.AgentStatusChanged, { status: 'thinking' }))
    expect(s.state.agent.messages.find((m) => m.id === 'm9')?.streaming).toBeUndefined()

    // A duplicate token stream — buffered before finalization — flushes
    // now. It must not re-mark the message as streaming (that swaps the
    // renderer back to StreamingText and re-fades the whole tail from
    // opacity 0) or re-set the status to 'generating'.
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'hello' } })
    await new Promise((r) => setTimeout(r, 5))
    expect(s.state.agent.messages.find((m) => m.id === 'm9')?.streaming).toBeFalsy()
    expect(s.state.agent.status).toBe('thinking')
  })

  it('clears finalized ids on resync so a fresh run is unaffected', async () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentStarted))
    s.applyBackendMessage(ev(3, Ev.AgentStatusChanged, { status: 'reasoning' }))
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'a' } })
    await new Promise((r) => setTimeout(r, 5))
    s.applyBackendMessage(ev(4, Ev.AgentMessage, { id: 'm9', role: 'assistant', text: 'a' }))
    // Resync (snapshot) resets the finalized set…
    s.applyBackendMessage(snap(5))
    s.applyBackendMessage(ev(6, Ev.AgentStatusChanged, { status: 'reasoning' }))
    // …so a stream for that id is no longer dropped.
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'a' } })
    await new Promise((r) => setTimeout(r, 5))
    expect(s.state.agent.messages.some((m) => m.id === 'm9')).toBe(true)
  })

  it('ignores token streams that flush after agent.completed', async () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentStarted))
    // Stream the final cumulative text — it's buffered via rAF, which
    // hasn't fired yet.
    s.applyBackendMessage({ type: 'stream', name: Stream.AgentToken, payload: { messageId: 'm9', text: 'final' } })
    // Events fire synchronously: the message is finalized and the agent
    // completes before the rAF flush lands.
    s.applyBackendMessage(ev(3, Ev.AgentMessage, { id: 'm9', role: 'assistant', text: 'final' }))
    s.applyBackendMessage(ev(4, Ev.AgentCompleted))
    expect(s.state.agent.status).toBe('idle')
    const msg = s.state.agent.messages.find((m) => m.id === 'm9')
    expect(msg?.streaming).toBeFalsy()

    // Now let the buffered stream flush.
    await new Promise((r) => setTimeout(r, 5))
    expect(s.state.agent.status).toBe('idle') // not reset to 'generating'
    const after = s.state.agent.messages.find((m) => m.id === 'm9')
    expect(after?.streaming).toBeFalsy() // still finalized, not re-marked
  })

  it('tracks approvals: focus on request, clear on resolve', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentToolStarted, { id: 'c1', tool: 'propose_edit', label: 'Edit foo.ts', status: 'running' }))
    const approval = { id: 'ap-1', kind: 'propose_edit', title: 'Edit foo.ts', path: 'foo.ts', what: 'w', why: 'y', diff: '+x' }
    s.applyBackendMessage(ev(3, Ev.ApprovalRequested, approval))
    expect(s.state.pendingApprovals).toHaveLength(1)
    expect(s.state.focusedApprovalId).toBe('ap-1')
    expect(s.state.agent.status).toBe('awaiting_tool_approval')
    expect(s.state.agent.toolCalls[0].status).toBe('pending_approval')
    // what should be persisted on the tool call from the approval
    expect(s.state.agent.toolCalls[0].what).toBe('w')
    // After completion, what should still be present
    s.applyBackendMessage(ev(4, Ev.AgentToolCompleted, { toolCallId: 'c1', status: 'done' }))
    expect(s.state.agent.toolCalls[0].what).toBe('w')
    expect(s.state.agent.toolCalls[0].status).toBe('done')

    s.applyBackendMessage(ev(5, Ev.ApprovalResolved, { approvalId: 'ap-1', decision: 'allow' }))
    expect(s.state.pendingApprovals).toHaveLength(0)
    expect(s.state.focusedApprovalId).toBeNull()
    expect(s.state.agent.status).toBe('reasoning')
  })

  it('updates content on content.updated', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.ContentUpdated, { path: 'content.md', content: '# Hi', updatedAt: 1 }))
    expect(s.state.content?.path).toBe('content.md')
  })
})

describe('window-sender filtering', () => {
  function snapTagged(seq: number): SnapshotMessage {
    return { ...snap(seq), windowName: 'main' }
  }

  it('drops events sent to another window', () => {
    const s = new UIStore()
    s.applyBackendMessage(snapTagged(1))
    s.applyBackendMessage(ev(2, Ev.AgentStatusChanged, { status: 'error' }), 'win-1')
    expect(s.state.agent.status).toBe('idle') // not applied
    expect(s.state.lastBackendSeq).toBe(1)
  })

  it('applies events sent to its own window', () => {
    const s = new UIStore()
    s.applyBackendMessage(snapTagged(1))
    s.applyBackendMessage(ev(2, Ev.AgentStatusChanged, { status: 'reasoning' }), 'main')
    expect(s.state.agent.status).toBe('reasoning')
    expect(s.state.lastBackendSeq).toBe(2)
  })

  it('applies events with no sender (pre-name or legacy)', () => {
    const s = new UIStore()
    s.applyBackendMessage(snapTagged(1))
    s.applyBackendMessage(ev(2, Ev.AgentStatusChanged, { status: 'reasoning' }))
    expect(s.state.agent.status).toBe('reasoning')
  })

  it('applies sent events before the snapshot identifies the window', () => {
    const s = new UIStore()
    // windowName unknown yet — cannot filter; pass-through is correct
    // (App.tsx buffers these until the snapshot lands anyway).
    s.applyBackendMessage(ev(1, Ev.AgentStatusChanged, { status: 'reasoning' }), 'main')
    expect(s.state.agent.status).toBe('reasoning')
  })
})

describe('approval focus reconciliation', () => {
  it('refocuses a new approval after a resync dropped the old one (dangling focus regression)', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    // ap-1 pending and focused…
    s.applyBackendMessage(ev(2, Ev.ApprovalRequested, { id: 'ap-1', kind: 'propose_edit', title: 'Edit a', path: 'a', what: '', why: '', diff: '' }))
    expect(s.state.focusedApprovalId).toBe('ap-1')
    // …a resync lands a snapshot where the backend no longer has ap-1
    // (agent switch / gap recovery): focus would dangle without reconcile.
    s.applyBackendMessage(snap(3))
    expect(s.state.pendingApprovals).toHaveLength(0)
    expect(s.state.focusedApprovalId).toBeNull()
    // The next approval must auto-focus (previously stayed stuck on ap-1).
    s.applyBackendMessage(ev(4, Ev.ApprovalRequested, { id: 'ap-2', kind: 'bash', title: 'Run', command: 'ls' }))
    expect(s.state.focusedApprovalId).toBe('ap-2')
  })

  it('keeps focus across a snapshot while the approval is still pending', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    const ap = { id: 'ap-1', kind: 'propose_edit', title: 'Edit a', path: 'a', what: '', why: '', diff: '' }
    s.applyBackendMessage(ev(2, Ev.ApprovalRequested, ap))
    const withPending = snap(3)
    withPending.state.pendingApprovals = [ap as never]
    s.applyBackendMessage(withPending)
    expect(s.state.focusedApprovalId).toBe('ap-1')
  })
})

describe('group collapse state', () => {
  it('starts collapsed (empty expanded set)', () => {
    const s = new UIStore()
    expect(s.state.expandedGroups).toBeInstanceOf(Set)
    expect(s.state.expandedGroups.size).toBe(0)
  })

  it('toggleGroup adds then removes a key', () => {
    const s = new UIStore()
    s.toggleGroup('read-c1')
    expect(s.state.expandedGroups.has('read-c1')).toBe(true)
    s.toggleGroup('read-c1')
    expect(s.state.expandedGroups.has('read-c1')).toBe(false)
    expect(s.state.expandedGroups.size).toBe(0)
  })

  it('collapseGroup removes a key (no-op if absent)', () => {
    const s = new UIStore()
    s.expandGroup('read-c1') // start expanded
    expect(s.state.expandedGroups.has('read-c1')).toBe(true)
    s.collapseGroup('read-c1')
    expect(s.state.expandedGroups.has('read-c1')).toBe(false)
    s.collapseGroup('read-c1') // no-op — already absent
    expect(s.state.expandedGroups.size).toBe(0)
  })

  it('expandGroup adds a key (no-op if already present)', () => {
    const s = new UIStore()
    s.expandGroup('read-c1')
    expect(s.state.expandedGroups.has('read-c1')).toBe(true)
    s.expandGroup('read-c1') // no-op
    expect(s.state.expandedGroups.size).toBe(1)
  })

  it('preserves expandedGroups across a snapshot resync', () => {
    const s = new UIStore()
    s.expandGroup('read-c1')
    s.applyBackendMessage(snap(5))
    // Snapshot does not carry expandedGroups — preserved via set() spread.
    expect(s.state.expandedGroups.has('read-c1')).toBe(true)
  })

  it('clears expandedGroups on AgentReset', () => {
    const s = new UIStore()
    s.expandGroup('read-c1')
    s.expandGroup('read-c3')
    expect(s.state.expandedGroups.size).toBeGreaterThan(0)
    s.applyBackendMessage(ev(2, Ev.AgentReset))
    expect(s.state.expandedGroups).toBeInstanceOf(Set)
    expect(s.state.expandedGroups.size).toBe(0)
  })

  it('does not affect expandedGroups on approval resolve', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AgentToolStarted, { id: 'c1', tool: 'propose_edit', label: 'Edit foo.ts', status: 'running' }))
    s.applyBackendMessage(ev(3, Ev.ApprovalRequested, { id: 'ap-1', kind: 'propose_edit', title: 'Edit foo.ts', path: 'foo.ts', what: 'w', why: 'y', diff: '+x' }))
    s.expandGroup('read-c1')
    expect(s.state.expandedGroups.has('read-c1')).toBe(true)
    s.applyBackendMessage(ev(4, Ev.AgentToolCompleted, { toolCallId: 'c1', status: 'done' }))
    s.applyBackendMessage(ev(5, Ev.ApprovalResolved, { approvalId: 'ap-1', decision: 'allow' }))
    expect(s.state.expandedGroups.has('read-c1')).toBe(true) // untouched
  })
})

describe('UIStore auth login flow', () => {
  it('tracks the flow through started → step → prompt → completed', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AuthLoginStarted, { loginId: 'L1', provider: 'github-copilot', authType: 'oauth' }))
    expect(s.state.auth.login).not.toBeNull()
    expect(s.state.auth.login!.provider).toBe('github-copilot')
    expect(s.state.auth.login!.result).toBeNull()

    s.applyBackendMessage(ev(3, Ev.AuthLoginStep, { loginId: 'L1', event: { type: 'device_code', message: 'Enter code', userCode: 'ABCD-1234', url: 'https://github.com/login/device' } }))
    expect(s.state.auth.login!.steps).toHaveLength(1)
    expect(s.state.auth.login!.steps[0].userCode).toBe('ABCD-1234')

    s.applyBackendMessage(ev(4, Ev.AuthLoginPrompt, { loginId: 'L1', promptId: 'P1', prompt: { type: 'manual_code', label: 'Code' } }))
    expect(s.state.auth.login!.prompt).toEqual({ promptId: 'P1', prompt: { type: 'manual_code', label: 'Code' } })

    s.applyBackendMessage(ev(5, Ev.AuthLoginCompleted, { loginId: 'L1', provider: 'github-copilot' }))
    expect(s.state.auth.login!.result).toBe('completed')
    expect(s.state.auth.login!.prompt).toBeNull()
  })

  it('records cancel and failure outcomes with messages', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.applyBackendMessage(ev(2, Ev.AuthLoginStarted, { loginId: 'L2', provider: 'openai', authType: 'oauth' }))
    s.applyBackendMessage(ev(3, Ev.AuthLoginCancelled, { loginId: 'L2', message: 'user cancelled' }))
    expect(s.state.auth.login!.result).toBe('cancelled')
    expect(s.state.auth.login!.message).toBe('user cancelled')

    s.beginAuthLogin({ loginId: 'L3', provider: 'xai', authType: 'oauth' })
    s.applyBackendMessage(ev(4, Ev.AuthLoginFailed, { loginId: 'L3', message: 'boom' }))
    expect(s.state.auth.login!.result).toBe('failed')
    expect(s.state.auth.login!.message).toBe('boom')
  })

  it('ignores flow events for a different loginId', () => {
    const s = new UIStore()
    s.applyBackendMessage(snap(1))
    s.beginAuthLogin({ loginId: 'L1', provider: 'a', authType: 'oauth' })
    s.applyBackendMessage(ev(2, Ev.AuthLoginStep, { loginId: 'OTHER', event: { type: 'info', message: 'nope' } }))
    expect(s.state.auth.login!.steps).toHaveLength(0)
    s.applyBackendMessage(ev(3, Ev.AuthLoginCompleted, { loginId: 'OTHER' }))
    expect(s.state.auth.login!.result).toBeNull() // still in flight
  })

  it('keeps an in-flight login across a status refresh but drops a finished one', () => {
    const s = new UIStore()
    const status = { providers: [{ id: 'a', name: 'A', oauth: true, apiKey: false, configured: false }], credentials: [] }
    s.setAuthStatus(status)
    s.beginAuthLogin({ loginId: 'L1', provider: 'a', authType: 'oauth' })
    s.setAuthStatus(status) // in-flight → preserved
    expect(s.state.auth.login).not.toBeNull()

    s.applyBackendMessage(snap(1)) // reset
    s.beginAuthLogin({ loginId: 'L2', provider: 'a', authType: 'oauth' })
    s.applyBackendMessage(ev(2, Ev.AuthLoginCompleted, { loginId: 'L2' }))
    s.setAuthStatus(status) // finished → dropped
    expect(s.state.auth.login).toBeNull()
  })

  it('stores models keyed by provider', () => {
    const s = new UIStore()
    s.setAuthModels([{ id: 'm1', name: 'M1', provider: 'a' }], 'a')
    expect(s.state.auth.modelsFor).toBe('a')
    s.setAuthModels([], 'b')
    expect(s.state.auth.modelsFor).toBe('b')
    expect(s.state.auth.models).toHaveLength(0)
  })
})
