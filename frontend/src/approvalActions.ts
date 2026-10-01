import { Cmd, type ApprovalRequest } from './protocol'

export interface ApprovalCommandClient {
  command(name: string, payload?: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }>
}

export function pickApprovalToRespond(approvals: ApprovalRequest[], focusedApprovalId: string | null): ApprovalRequest | null {
  return approvals.find((approval) => approval.id === focusedApprovalId) ?? approvals[0] ?? null
}

export async function dismissPendingApprovals(client: ApprovalCommandClient, approvals: ApprovalRequest[]): Promise<void> {
  for (const approval of approvals) {
    try {
      const resp = await client.command(Cmd.ApprovalRespond, { approvalId: approval.id, decision: 'dismiss' })
      if (!resp.ok) {
        console.warn('dismiss approval failed', approval.id, resp.error)
      }
    } catch (err) {
      console.warn('dismiss approval failed', approval.id, err)
    }
  }
}
