import type { ToolCall } from './protocol'

/**
 * A group of tool calls rendered as a single collapsible unit in the
 * ToolLog. A group may contain one (singleton) or many tool calls.
 *
 * Groups are derived data — recompute via `groupToolCalls` whenever the
 * flat tool call array changes. Collapsed/expanded state is tracked
 * separately (by `key`) in the store, not on this type.
 */
export interface ToolCallGroup {
  /** Stable key for collapsed/expanded state persistence across re-renders. */
  key: string
  /** Human-readable label, e.g. "Read 3 files". */
  label: string
  /** The tool calls in this group. Always non-empty. */
  toolCalls: ToolCall[]
  /** Name of the grouper that created this group, or null for singlets. */
  grouper: string | null
}

/**
 * A pluggable grouping strategy. Groupers are tried in priority order;
 * at each position in the tool call stream, the first grouper whose
 * `isRelevant` returns true forms a group via `formGroup`.
 *
 * Contract: if `isRelevant` returns true, `formGroup` will always succeed.
 * `isRelevant` must verify everything needed for a valid group,
 * including minimum thresholds — there is no null return from `formGroup`.
 */
export interface ToolCallGrouper {
  /** Unique identifier (also set on ToolCallGroup.grouper). */
  name: string
  /**
   * Can this grouper form a valid group starting at `startIndex`?
   * Must check tool type, minimum count, and any other constraints.
   * Cheap — should only look at calls from startIndex forward.
   */
  isRelevant(calls: ToolCall[], startIndex: number, lastGroup: ToolCallGroup | null): boolean
  /**
   * Form a group starting at `startIndex`. Only called when isRelevant
   * returned true — always succeeds. Consumes a prefix of calls.
   */
  formGroup(calls: ToolCall[], startIndex: number, lastGroup: ToolCallGroup | null): ToolCallGroup
}

// ---------------------------------------------------------------------------
// ReadGrouper: groups consecutive `read` tool calls
// ---------------------------------------------------------------------------

const READ_MIN = 2

/**
 * Scan forward from startIndex, collecting consecutive `read` calls.
 * Shared by isRelevant (threshold check) and formGroup (actual grouping)
 * to avoid duplicating the scan logic.
 */
function scanReads(calls: ToolCall[], startIndex: number): ToolCall[] {
  const run: ToolCall[] = []
  for (let i = startIndex; i < calls.length; i++) {
    if (calls[i].tool !== 'read') break
    run.push(calls[i])
  }
  return run
}

/**
 * Groups consecutive `read` tool calls into a single "Read N files" group.
 * A single read (below READ_MIN) means isRelevant returns false and the
 * orchestrator falls back to a singlet.
 */
export const readGrouper: ToolCallGrouper = {
  name: 'read',
  isRelevant(calls, startIndex) {
    if (calls[startIndex].tool !== 'read') return false
    return scanReads(calls, startIndex).length >= READ_MIN
  },
  formGroup(calls, startIndex) {
    const run = scanReads(calls, startIndex)
    return {
      key: `read-${run[0].id}`,
      label: `Read ${run.length} file${run.length === 1 ? '' : 's'}`,
      toolCalls: run,
      grouper: 'read',
    }
  },
}

// ---------------------------------------------------------------------------
// AgentGrouper: groups consecutive tool calls with the same agent-assigned
// groupLabel. Normalization (slugify) tolerates typos, casing, and
// punctuation differences so "Read Files" === "read_files".
// ---------------------------------------------------------------------------

function normalizeGroupLabel(label: string): string {
  // The extension's prepareArguments auto-fills "_default" when the LLM
  // doesn't provide a groupLabel. Treat it as "no label" so calls without
  // explicit agent intent fall through to readGrouper (which produces
  // nicer group headers like "Read 3 files").
  if (label === '_default') return ''
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function scanAgentGroup(
  calls: ToolCall[],
  startIndex: number,
  normalizedLabel: string,
): ToolCall[] {
  const run: ToolCall[] = [calls[startIndex]]
  for (let i = startIndex + 1; i < calls.length; i++) {
    const norm = normalizeGroupLabel(calls[i].groupLabel ?? '')
    if (norm !== normalizedLabel) break
    run.push(calls[i])
  }
  return run
}

export const agentGrouper: ToolCallGrouper = {
  name: 'agent',
  isRelevant(calls, startIndex) {
    const raw = calls[startIndex].groupLabel
    if (!raw) return false
    const norm = normalizeGroupLabel(raw)
    if (!norm) return false // empty after normalization = no group
    return scanAgentGroup(calls, startIndex, norm).length >= 2
  },
  formGroup(calls, startIndex) {
    const norm = normalizeGroupLabel(calls[startIndex].groupLabel ?? '')
    const run = scanAgentGroup(calls, startIndex, norm)
    return {
      key: `agent-${norm}-${run[0].id}`,
      label: calls[startIndex].groupLabel ?? '', // raw, for display
      toolCalls: run,
      grouper: 'agent',
    }
  },
}

/**
 * The default groupers, in priority order. The first relevant grouper
 * at each position wins. Agent-labeled groups take priority over the
 * default consecutive-read grouping, so explicit LLM intent overrides
 * the heuristic.
 */
export const defaultGroupers: ToolCallGrouper[] = [agentGrouper, readGrouper]

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Group a flat list of tool calls using the given groupers.
 *
 * Returns a flat list of groups where each tool call appears in exactly
 * one group (either a multi-call group or a singleton). Multi-call groups
 * always claim a *consecutive* run — a non-matching tool breaks the run.
 *
 * **Performance**: O(n * g) where n = tool calls and g = groupers. Each
 * isRelevant checks at most the next call's tool type plus a short forward
 * scan. Memoize externally (e.g. useMemo on the toolCalls ref) to avoid
 * recomputation when nothing changed.
 *
 * **Stability**: group keys derive from tool call IDs + grouper name, so
 * they persist across re-derivations when the underlying list is structurally
 * the same (e.g. a status update to one call). This keeps collapsed/expanded
 * state intact.
 */
export function groupToolCalls(
  toolCalls: ToolCall[],
  groupers: ToolCallGrouper[] = defaultGroupers,
): ToolCallGroup[] {
  const result: ToolCallGroup[] = []
  let i = 0
  while (i < toolCalls.length) {
    const lastGroup = result.length > 0 ? result[result.length - 1] : null
    let grouped = false
    for (const grouper of groupers) {
      if (!grouper.isRelevant(toolCalls, i, lastGroup)) continue
      const group = grouper.formGroup(toolCalls, i, lastGroup)
      result.push(group)
      i += group.toolCalls.length
      grouped = true
      break
    }
    if (!grouped) {
      // No grouper claimed this call — it becomes a singleton.
      result.push({
        key: toolCalls[i].id,
        label: toolCalls[i].label,
        toolCalls: [toolCalls[i]],
        grouper: null,
      })
      i++
    }
  }
  return result
}
