import type { ApprovalRequest, ContentDoc, ToolCall } from './protocol'

/** What the content panel shows, by precedence:
 *
 *  1. an explicitly focused approval (clicked in chat)
 *  2. an explicitly focused tool call
 *  3. user-pinned content (picked from the library dropdown) — this is how
 *     content can be browsed while an approval is pending
 *  4. the first pending approval (attention fallback)
 *  5. the latest content
 *  6. empty
 */
export type PanelView =
  | { kind: 'approval'; approval: ApprovalRequest }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'content'; doc: ContentDoc }
  | { kind: 'empty' }

export function resolvePanelView(s: {
  focusedApprovalId: string | null
  focusedToolCallId: string | null
  contentPinned: boolean
  content: ContentDoc | null
  pendingApprovals: ApprovalRequest[]
  toolCalls: ToolCall[]
}): PanelView {
  if (s.focusedApprovalId) {
    const a = s.pendingApprovals.find((x) => x.id === s.focusedApprovalId)
    if (a) return { kind: 'approval', approval: a }
  }
  if (s.focusedToolCallId) {
    const c = s.toolCalls.find((x) => x.id === s.focusedToolCallId)
    if (c) return { kind: 'tool', call: c }
  }
  if (s.contentPinned && s.content) return { kind: 'content', doc: s.content }
  const fallback = s.pendingApprovals[0]
  if (fallback) return { kind: 'approval', approval: fallback }
  if (s.content) return { kind: 'content', doc: s.content }
  return { kind: 'empty' }
}
