import { describe, expect, it } from 'vitest'
import { readProviderModel, withProviderModel } from './yamlPatch'

// Mirrors the shipped DefaultSettingsYAML (internal/core/settings.go).
const TEMPLATE = `# coconut settings

provider: anthropic

# Model pattern (optional): bare id, provider/model, or provider/model:thinking.
# model: claude-sonnet-4-5

apiKey: ""

# providers:
#   openrouter:
#     baseUrl: https://openrouter.ai/api/v1
#     apiKey: sk-or-...
`

describe('withProviderModel', () => {
  it('replaces the live provider line', () => {
    const out = withProviderModel(TEMPLATE, 'github-copilot', null)
    expect(out).toMatch(/^provider: github-copilot$/m)
    expect(out).not.toMatch(/^model:/m) // no live model line…
    expect(out).toMatch(/^#\s*model:/m) // …the commented one stays put
  })

  it('uncomments the template model line when a model is chosen', () => {
    const out = withProviderModel(TEMPLATE, 'anthropic', 'claude-sonnet-4-5')
    expect(out).toMatch(/^model: claude-sonnet-4-5$/m)
    expect(out).not.toMatch(/^#\s*model:/m)
  })

  it('replaces an already-live model line', () => {
    const yaml = TEMPLATE.replace('# model: claude-sonnet-4-5', 'model: gpt-5')
    const out = withProviderModel(yaml, 'openai', 'gpt-5-mini')
    expect(out).toMatch(/^model: gpt-5-mini$/m)
  })

  it('never touches the indented providers: block or providers: keys', () => {
    const yaml = [
      'provider: anthropic',
      '',
      'providers:',
      '  openrouter:',
      '    baseUrl: https://openrouter.ai/api/v1',
      '    apiKey: sk-or-x',
      '',
    ].join('\n')
    const out = withProviderModel(yaml, 'openrouter', 'anthropic/claude-sonnet-4')
    expect(out).toMatch(/^provider: openrouter$/m)
    expect(out).toContain('    apiKey: sk-or-x') // untouched
    expect(out).toMatch(/^model: anthropic\/claude-sonnet-4$/m)
  })

  it('adds provider/model lines when missing entirely', () => {
    const out = withProviderModel('# just comments\n', 'groq', 'llama-3')
    expect(out).toMatch(/^provider: groq$/m)
    expect(out).toMatch(/^model: llama-3$/m)
  })

  it('comments out a live model line when no model is chosen', () => {
    const yaml = TEMPLATE.replace('# model: claude-sonnet-4-5', 'model: gpt-5')
    const out = withProviderModel(yaml, 'anthropic', null)
    expect(out).not.toMatch(/^model:/m)
    expect(out).toMatch(/^# model: gpt-5$/m)
  })

  it('revives the commented model line when a model is chosen again', () => {
    const yaml = TEMPLATE.replace('# model: claude-sonnet-4-5', 'model: gpt-5')
    const cleared = withProviderModel(yaml, 'anthropic', null)
    const out = withProviderModel(cleared, 'anthropic', 'claude-opus-4')
    expect(out).toMatch(/^model: claude-opus-4$/m)
    expect(out.match(/^#?\s*model:/gm)).toHaveLength(1)
  })
})

describe('readProviderModel', () => {
  it('reads live provider/model lines', () => {
    const yaml = TEMPLATE.replace('# model: claude-sonnet-4-5', 'model: claude-sonnet-4-5')
    expect(readProviderModel(yaml)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
  })

  it('ignores commented lines and blank values', () => {
    expect(readProviderModel(TEMPLATE)).toEqual({ provider: 'anthropic', model: null })
    expect(readProviderModel('# provider: x\nprovider:\n')).toEqual({ provider: null, model: null })
  })

  it('ignores indented providers: entries', () => {
    const yaml = 'providers:\n  openrouter:\n    model: nope\n'
    expect(readProviderModel(yaml)).toEqual({ provider: null, model: null })
  })
})
