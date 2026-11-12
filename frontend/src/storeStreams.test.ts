import { describe, expect, it } from 'vitest'
import { UIStore } from './store'
import { applyStreamPayload } from './storeStreams'
import { Stream } from './protocol'

/** A store mid-run — token streaming is refused while the run is terminal. */
function live(): UIStore {
  const store = new UIStore()
  store.setAgent({ status: 'reasoning' })
  return store
}

describe('applyStreamPayload', () => {
  it('creates a streaming assistant message and flips status to generating', () => {
    const store = live()
    applyStreamPayload(store, Stream.AgentToken, { messageId: 'm1', text: 'he' })
    expect(store.state.agent.status).toBe('generating')
    expect(store.state.agent.messages).toEqual([{ id: 'm1', role: 'assistant', text: 'he', streaming: true }])
  })

  it('replaces cumulative token text in place', () => {
    const store = live()
    applyStreamPayload(store, Stream.AgentToken, { messageId: 'm1', text: 'hello ' })
    applyStreamPayload(store, Stream.AgentToken, { messageId: 'm1', text: 'hello world' })
    expect(store.state.agent.messages).toHaveLength(1)
    expect(store.state.agent.messages[0].text).toBe('hello world')
  })

  it('does not revive a terminal run (agent.completed can land first)', () => {
    const store = new UIStore() // status: idle
    applyStreamPayload(store, Stream.AgentToken, { messageId: 'm1', text: 'late' })
    expect(store.state.agent.messages).toHaveLength(0)
    expect(store.state.agent.status).toBe('idle')
  })

  it('skips a message already finalized by agent.message.appended (late RAF flush)', () => {
    const store = live()
    store.finalized.add('m1')
    applyStreamPayload(store, Stream.AgentToken, { messageId: 'm1', text: 'late' })
    expect(store.state.agent.messages).toHaveLength(0)
  })

  it('adds thinking without touching status', () => {
    const store = live()
    applyStreamPayload(store, Stream.AgentThinking, { messageId: 'm1', text: 'pondering' })
    expect(store.state.agent.status).toBe('reasoning')
    expect(store.state.agent.messages[0]).toMatchObject({ thinking: 'pondering', thinkingDone: false })
  })

  it('preserves thinkingDone/thinkingMs already set by the completed event', () => {
    const store = live()
    store.setAgent({
      messages: [{ id: 'm1', role: 'assistant', text: '', thinking: 'stale', thinkingDone: true, thinkingMs: 900 }],
    })
    applyStreamPayload(store, Stream.AgentThinking, { messageId: 'm1', text: 'fuller' })
    expect(store.state.agent.messages[0]).toMatchObject({ thinking: 'fuller', thinkingDone: true, thinkingMs: 900 })
  })

  it('ignores unknown stream names', () => {
    const store = live()
    applyStreamPayload(store, 'agent.mystery', { messageId: 'm1', text: 'x' })
    expect(store.state.agent.messages).toHaveLength(0)
  })
})