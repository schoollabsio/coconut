import type { TimelineEntry } from '../../timeline'
import type { ToolCallGroup } from '../../toolGrouping'
import type { ChatMessage, ToolCall } from '../../protocol'

export type RenderRow =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'thinking'; key: string; railKey: string; message: ChatMessage }
  | { kind: 'text'; key: string; railKey: string; message: ChatMessage }
  | { kind: 'tool'; key: string; railKey: string; call: ToolCall; lane: 'main' | 'child' }
  | { kind: 'group'; key: string; railKey: string; group: ToolCallGroup; expanded: boolean }
  | { kind: 'group-tool'; key: string; railKey: string; call: ToolCall; parentKey: string }

type GroupEntry = Extract<TimelineEntry, { kind: 'group' }>
type FlatEntry = Exclude<TimelineEntry, { kind: 'group' }>

/** Build the rows to render, unfolding an expanded group into its children. */
export function buildRailRows(timeline: TimelineEntry[], expandedGroups: Set<string>): RenderRow[] {
  const groups = timeline.filter((entry): entry is GroupEntry => entry.kind === 'group')
  const indexByKey = new Map<string, number>(groups.map((group, index) => [group.key, index]))
  const rows: RenderRow[] = []

  for (const entry of timeline) {
    if (entry.kind === 'group') {
      pushGroupRows(rows, entry, expandedGroups, indexByKey, groups.length)
      continue
    }
    rows.push(toFlatRow(entry))
  }

  return rows
}

function pushGroupRows(
  rows: RenderRow[],
  entry: GroupEntry,
  expandedGroups: Set<string>,
  indexByKey: Map<string, number>,
  groupCount: number,
): void {
  // The newest group stays open even when never toggled, so the live run's
  // children are visible without a click.
  const expanded = expandedGroups.has(entry.group.key) || indexByKey.get(entry.key) === groupCount - 1
  rows.push({ kind: 'group', key: entry.key, railKey: entry.key, group: entry.group, expanded })
  if (!expanded) return
  for (const call of entry.group.toolCalls) {
    rows.push({ kind: 'group-tool', key: call.id, railKey: call.id, call, parentKey: entry.group.key })
  }
}

function toFlatRow(entry: FlatEntry): RenderRow {
  switch (entry.kind) {
    case 'user':
      return { kind: 'user', key: entry.key, message: entry.message }
    case 'thinking':
      return { kind: 'thinking', key: entry.key, railKey: entry.key, message: entry.message }
    case 'text':
      return { kind: 'text', key: entry.key, railKey: entry.key, message: entry.message }
    case 'tool':
      return { kind: 'tool', key: entry.key, railKey: entry.key, call: entry.call, lane: 'main' }
  }
}

export function sameGroup(a: ToolCallGroup, b: ToolCallGroup): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.grouper === b.grouper &&
    a.toolCalls.length === b.toolCalls.length &&
    a.toolCalls.every((call, index) => call === b.toolCalls[index])
  )
}

export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, thresholdPx = 24): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx
}

function formatThinkingDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
  const mins = Math.round(secs / 60)
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
}

export { formatThinkingDuration }

// MemoMarkdown is a component; we'll keep it in the main Chat component for now.
