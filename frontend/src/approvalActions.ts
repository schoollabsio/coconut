import { Cmd, type ApprovalRequest } from './protocol'

export interface ApprovalCommandClient {
  command(name: string, payload?: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }>
}

export function pickApprovalToRespond(approvals: ApprovalRequest[], focusedApprovalId: string | null): ApprovalRequest | null {
  return approvals.find((approval) => approval.id === focusedApprovalId) ?? approvals[0] ?? null
}

export type ApprovalDecision = 'allow' | 'dismiss'

/** Send one decision and report whether the backend accepted it. The click
 *  handlers and the auto-approve timer both go through here, so a
 *  timer-approved decision is byte-for-byte the request a click makes. */
export async function respondToApproval(
  client: ApprovalCommandClient,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  try {
    const resp = await client.command(Cmd.ApprovalRespond, { approvalId, decision })
    if (!resp.ok) console.warn('approval respond failed', approvalId, decision, resp.error)
    return resp.ok
  } catch (err) {
    console.warn('approval respond failed', approvalId, decision, err)
    return false
  }
}

/** Sweep every pending approval (dismiss-on-send before a new prompt). */
export async function dismissPendingApprovals(client: ApprovalCommandClient, approvals: ApprovalRequest[]): Promise<void> {
  for (const approval of approvals) {
    await respondToApproval(client, approval.id, 'dismiss')
  }
}

