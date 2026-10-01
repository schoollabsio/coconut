/**
 * yamlPatch — pure helpers for patching settings.yaml from structured UI
 * (no backend/React deps so it's unit-testable in Node).
 */

/** Rewrite the top-level provider:/model: lines of settings.yaml.
 *
 *  Anchored to line start, so indented entries under a live `providers:`
 *  block are untouched; `^provider:` cannot match `providers:` (the colon
 *  must come right after the name), nor `# provider:` (comment lines are
 *  only matched by their own branch). When a model is chosen and only a
 *  commented `# model:` line exists (the shipped template), it is
 *  uncommented rather than duplicated. When NO model is chosen (null), a
 *  live `model:` line is commented out — there is no "provider default"
 *  escape hatch, so a stale pick (possibly from another provider) must not
 *  linger; choosing a model later revives the commented line.
 */
export function withProviderModel(yaml: string, provider: string, model: string | null): string {
  let out = yaml
  if (/^provider:[^\n]*/m.test(out)) {
    out = out.replace(/^provider:[^\n]*/m, `provider: ${provider}`)
  } else if (/^#\s*provider:[^\n]*/m.test(out)) {
    out = out.replace(/^#\s*provider:[^\n]*/m, `provider: ${provider}`)
  } else {
    out = `provider: ${provider}\n` + out
  }
  if (model) {
    if (/^model:[^\n]*/m.test(out)) {
      out = out.replace(/^model:[^\n]*/m, `model: ${model}`)
    } else if (/^#\s*model:[^\n]*/m.test(out)) {
      out = out.replace(/^#\s*model:[^\n]*/m, `model: ${model}`)
    } else {
      out = out.replace(/^provider:[^\n]*/m, (m) => `${m}\nmodel: ${model}`)
    }
  } else {
    out = out.replace(/^model:[^\n]*/m, (m) => `# ${m}`)
  }
  return out
}

/** Read the live top-level provider:/model: lines of settings.yaml.
 *
 *  Inverse of withProviderModel: commented lines (`# model:`) and indented
 *  entries under a providers: block are ignored; blank values read as null.
 *  The model is returned raw — it may be provider-prefixed or carry a
 *  `:thinking` suffix (see modelRef.stripModelRef for matching it against
 *  bare model ids).
 */
export function readProviderModel(yaml: string): { provider: string | null; model: string | null } {
  const value = (name: string): string | null => {
    const m = new RegExp(`^${name}:[^\\n]*`, 'm').exec(yaml)
    if (!m) return null
    const v = m[0].slice(name.length + 1).trim()
    return v === '' ? null : v
  }
  return { provider: value('provider'), model: value('model') }
}
