import { describe, expect, it } from 'vitest'
import { modelDisplayName, stripModelRef } from './modelRef'
import type { AuthModel } from './protocol'

describe('stripModelRef', () => {
  it('returns bare ids unchanged', () => {
    expect(stripModelRef('kimi-k3', 'github-copilot')).toBe('kimi-k3')
  })

  it('strips the active provider prefix', () => {
    expect(stripModelRef('github-copilot/kimi-k3', 'github-copilot')).toBe('kimi-k3')
  })

  it('strips a thinking suffix, with or without prefix', () => {
    expect(stripModelRef('kimi-k3:thinking', 'github-copilot')).toBe('kimi-k3')
    expect(stripModelRef('github-copilot/kimi-k3:thinking', 'github-copilot')).toBe('kimi-k3')
  })

  it('keeps prefixes that name a different provider', () => {
    expect(stripModelRef('openai/gpt-5', 'github-copilot')).toBe('openai/gpt-5')
  })
})

describe('modelDisplayName', () => {
  const models: AuthModel[] = [
    { id: 'kimi-k3', name: 'Kimi K3', provider: 'github-copilot' },
    { id: 'gpt-5', name: 'gpt-5', provider: 'github-copilot' },
  ]

  it('prefers the friendly name when it differs from the id', () => {
    expect(modelDisplayName('github-copilot/kimi-k3', 'github-copilot', models)).toBe('Kimi K3')
  })

  it('falls back to the bare id when names match or the model is unlisted', () => {
    expect(modelDisplayName('gpt-5', 'github-copilot', models)).toBe('gpt-5')
    expect(modelDisplayName('unlisted', 'github-copilot', models)).toBe('unlisted')
  })

  it('returns empty for an unset model', () => {
    expect(modelDisplayName('', 'github-copilot', models)).toBe('')
  })
})
