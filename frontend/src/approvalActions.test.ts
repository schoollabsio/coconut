import { describe, expect, it, vi } from 'vitest'
import { dismissPendingApprovals, pickApprovalToRespond } from './approvalActions'
import type { ApprovalRequest } from './protocol'

describe('pickApprovalToRespond', () => {
  const approvals: ApprovalRequest[] = [
    { id: 'ap-1', kind: 'propose_edit', title: 'Edit a.ts' },
    { id: 'ap-2', kind: 'bash', title: 'Run ls', command: 'ls' },
  ]

  it('returns the focused approval when it is still pending', () => {
    expect(pickApprovalToRespond(approvals, 'ap-2')?.id).toBe('ap-2')
  })

  it('falls back to the first pending approval when focus is empty or stale', () => {
    expect(pickApprovalToRespond(approvals, null)?.id).toBe('ap-1')
    expect(pickApprovalToRespond(approvals, 'missing')?.id).toBe('ap-1')
  })

  it('returns null when nothing is pending', () => {
    expect(pickApprovalToRespond([], null)).toBeNull()
  })
})

describe('dismissPendingApprovals', () => {
  it('dismisses approvals sequentially, awaiting each response before the next send', async () => {
    const approvals: ApprovalRequest[] = [
      { id: 'ap-1', kind: 'propose_edit', title: 'Edit a.ts' },
      { id: 'ap-2', kind: 'bash', title: 'Run ls', command: 'ls' },
    ]

    const calls: Array<{ id: string; payload?: unknown }> = []
    let resolveFirst!: (value: { ok: boolean }) => void
    const first = new Promise<{ ok: boolean }>((resolve) => {
      resolveFirst = resolve
    })

    const client = {
      command: vi.fn(async (_name: string, payload?: unknown) => {
        const approvalId = (payload as { approvalId: string }).approvalId
        calls.push({ id: approvalId, payload })
        if (approvalId === 'ap-1') return first
        return { ok: true }
      }),
    }

    const pending = dismissPendingApprovals(client, approvals)
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.id).toBe('ap-1')

    resolveFirst({ ok: true })
    await pending

    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.id)).toEqual(['ap-1', 'ap-2'])
  })
})
