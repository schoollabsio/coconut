import { describe, expect, it } from 'vitest'
import { withProviderModel } from '../yamlPatch'

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
})
