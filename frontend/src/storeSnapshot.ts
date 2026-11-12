/**
 * Snapshot → state patch (PLAN.md §8.4). A snapshot replaces the
 * backend-derived client state wholesale; the only thing carried over is
 * *focus*, and it must be reconciled against the snapshot's own lists — a
 * stale focus id (e.g. an approval resolved while we were disconnected and
 * resyncing) would otherwise block auto-focus of new approvals forever.
 */
import type { SnapshotMessage, SnapshotState } from './protocol'
import type { UIState } from './storeState'

export function snapshotPatch(prev: UIState, snap: SnapshotMessage): Partial<UIState> {
  const s = snap.state
  // Keep the focused approval while it is still pending; otherwise focus the
  // first pending one so the panel shows something actionable.
  const focusedApprovalId = s.pendingApprovals.some((a) => a.id === prev.focusedApprovalId)
    ? prev.focusedApprovalId
    : (s.pendingApprovals[0]?.id ?? null)
  return {
    connected: true,
    needsWorkspace: !(s.workspace?.path),
    lastBackendSeq: snap.seq,
    agentName: s.agentName || 'Untitled Agent',
    agentSlug: s.agentSlug || '',
    workspace: s.workspace?.path ? s.workspace : null,
    agent: {
      status: s.agent.status,
      messages: [...s.agent.messages],
      toolCalls: [...s.agent.toolCalls],
    },
    content: s.content,
    contentLibrary: s.contentLibrary ?? [],
    // A pin survives resync only while its document is still there.
    contentPinned: prev.contentPinned && s.content != null,
    pendingApprovals: [...s.pendingApprovals],
    focusedApprovalId,
    focusedToolCallId: reconcileToolFocus(focusedApprovalId, prev, s),
    settingsYaml: s.settingsYaml,
  }
}

/** An approval focus wins; otherwise the tool-call focus survives only while
 *  that call is still in the snapshot. */
function reconcileToolFocus(focusedApprovalId: string | null, prev: UIState, s: SnapshotState): string | null {
  if (focusedApprovalId) return null
  return s.agent.toolCalls.some((c) => c.id === prev.focusedToolCallId) ? prev.focusedToolCallId : null
}
