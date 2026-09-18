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
 *  uncommented rather than duplicated.
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
  }
  return out
}
