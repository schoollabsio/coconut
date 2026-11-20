/**
 * The timing rules for auto-approve, exercised without a store: a fake context
 * over the real initialState plus fake timers. The budget arithmetic itself is
 * pinned in autoApprove.test.ts; what matters here is WHEN a decision fires and
 * what stops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disableClocks, enableClocks, fireClock, spendClock, sweepDueClocks, syncClocks, type ClockCtx, type ClockTimers } from './storeClocks'
import { AUTO_APPROVE_DEFAULTS } from './autoApprove'
import { initialState } from './storeState'
import type { ApprovalRequest } from './protocol'

const FLOOR = AUTO_APPROVE_DEFAULTS.floorMs

/** Terse prose, so every budget below is the floor — timing, not arithmetic. */
function approval(id: string): ApprovalRequest {
  return { id, kind: 'propose_edit', title: `coconut://propose_edit`, path: 'a.ts', what: 'Fix typo', why: 'spelling' }
}

function makeCtx(on: boolean, approvals: ApprovalRequest[], respondApproval: ClockCtx['respondApproval'] = vi.fn().mockResolvedValue(true)) {
  const notes: string[] = []
  const ctx: ClockCtx = {
    state: { ...initialState, pendingApprovals: approvals, autoApprove: { on, deadlines: {} } },
    set: (patch) => {
      ctx.state = { ...ctx.state, ...patch }
    },
    pushNotification: (_level, message) => notes.push(message),
    respondApproval,
  }
  return { ctx, notes, sent: respondApproval as ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('syncClocks', () => {
  it('arms nothing while the switch is off', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(false, [approval('ap-1')])
    syncClocks(ctx, timers)
    expect(timers.size).toBe(0)
    expect(ctx.state.autoApprove.deadlines).toEqual({})
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).not.toHaveBeenCalled()
  })

  it('arms a pending approval and sends allow when its budget elapses', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('running')

    vi.advanceTimersByTime(FLOOR - 1)
    expect(sent).not.toHaveBeenCalled() // the window is the whole point

    vi.advanceTimersByTime(1)
    expect(sent).toHaveBeenCalledWith('ap-1', 'allow')
  })

  it('drops the clock when the approval is resolved', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    ctx.state = { ...ctx.state, pendingApprovals: [] } // the resolve event landed
    syncClocks(ctx, timers)
    expect(timers.size).toBe(0)
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).not.toHaveBeenCalled()
  })

  it('does not arm an approval that was already waiting when the mode came on', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(false, [approval('ap-1')])
    syncClocks(ctx, timers) // off: nothing armed

    enableClocks(ctx, timers) // the header click

    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('manual')
    expect(timers.size).toBe(0)
    vi.advanceTimersByTime(FLOOR * 100)
    expect(sent).not.toHaveBeenCalled()
  })

  it('arms an approval that arrives after the mode came on', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(false, [])
    enableClocks(ctx, timers)

    // A request that lands while the mode is on gets the full reading time.
    ctx.state = { ...ctx.state, pendingApprovals: [approval('ap-1')] }
    syncClocks(ctx, timers)
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('running')

    vi.advanceTimersByTime(FLOOR - 1)
    expect(sent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(sent).toHaveBeenCalledWith('ap-1', 'allow')
  })
})

describe('cancel timer', () => {
  it('stops a clock for good', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    spendClock(ctx, timers, 'ap-1')

    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('cancelled')
    expect(timers.size).toBe(0)
    vi.advanceTimersByTime(FLOOR * 100)
    expect(sent).not.toHaveBeenCalled()
  })

  it('is not re-armed by a later sync, nor by switching the mode on', () => {
    const timers: ClockTimers = new Map()
    const { ctx } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    spendClock(ctx, timers, 'ap-1')

    syncClocks(ctx, timers) // an unrelated event re-plans the pending set
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('cancelled')
    expect(timers.size).toBe(0)

    enableClocks(ctx, timers) // and even a fresh flip of the switch
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('cancelled')
    expect(timers.size).toBe(0)
  })

  it('survives an off/on round trip of the window switch', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    spendClock(ctx, timers, 'ap-1')

    // Off kills the timer; back on must not light another one under the
    // approval this user opted out of — it comes back untimed, not armed.
    disableClocks(ctx, timers)
    enableClocks(ctx, timers)

    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('manual')
    expect(timers.size).toBe(0)
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('turning the mode off', () => {
  it('kills every armed clock immediately', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1'), approval('ap-2')])
    syncClocks(ctx, timers)
    expect(timers.size).toBe(2)

    disableClocks(ctx, timers)
    expect(ctx.state.autoApprove.on).toBe(false)
    expect(ctx.state.autoApprove.deadlines).toEqual({})
    expect(timers.size).toBe(0)
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('fireClock', () => {
  it('spends the clock before sending, so one deadline cannot fire twice', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)

    vi.advanceTimersByTime(FLOOR) // fires; the backend has not confirmed yet
    expect(sent).toHaveBeenCalledOnce()

    syncClocks(ctx, timers) // a re-plan while the approval is still pending
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).toHaveBeenCalledOnce()
  })

  it('stays silent when the approval was resolved mid-flight', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent, notes } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    ctx.state = { ...ctx.state, pendingApprovals: [] } // a click won the race

    fireClock(ctx, timers, 'ap-1')
    expect(sent).not.toHaveBeenCalled()
    expect(notes).toEqual([])
  })

  it('says so when there is no transport to send through', () => {
    const timers: ClockTimers = new Map()
    const { ctx, notes } = makeCtx(true, [approval('ap-1')], null)
    syncClocks(ctx, timers)

    vi.advanceTimersByTime(FLOOR)
    expect(notes.some((n) => n.includes('no backend connection'))).toBe(true)
  })

  it('warns when the backend rejects a stale approval', async () => {
    const timers: ClockTimers = new Map()
    const { ctx, notes } = makeCtx(true, [approval('ap-1')], vi.fn().mockResolvedValue(false))
    syncClocks(ctx, timers)

    vi.advanceTimersByTime(FLOOR)
    await Promise.resolve() // the response handler is a microtask
    expect(notes.some((n) => n.includes('no longer applied'))).toBe(true)
  })
})

describe('a clock that fires', () => {
  it('marks it fired, not cancelled — the user did not take it back', () => {
    // The card renders this mode; as `cancelled` it told the user they had
    // stopped the countdown, and dropped the bar mid-drain.
    const timers: ClockTimers = new Map()
    const { ctx } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)

    vi.advanceTimersByTime(FLOOR)
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('fired')
  })

  it('is never re-armed — not by a sync, not by cycling the switch', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    vi.advanceTimersByTime(FLOOR)

    syncClocks(ctx, timers) // an unrelated event re-plans the pending set
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('fired')

    // Switching off wipes every clock by design (a cancelled one behaves the
    // same way), so back on it comes forward-only as `manual` — never re-armed.
    // What matters is that it cannot fire a second time either way.
    disableClocks(ctx, timers)
    enableClocks(ctx, timers)

    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).not.toBe('running')
    vi.advanceTimersByTime(FLOOR * 10)
    expect(sent).toHaveBeenCalledOnce()
  })
})

describe('sweepDueClocks', () => {
  it('fires a clock whose timer never landed', () => {
    // The reason this exists: a hidden window throttles its timers and a
    // suspended machine sleeps clean through a deadline, so the callback that
    // was due may simply never arrive.
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)

    // The scheduled handle is gone but the wall clock still walked past
    // expiresAt — the missed-callback state, not an early one.
    for (const { handle } of timers.values()) clearTimeout(handle)
    timers.clear()
    vi.advanceTimersByTime(FLOOR + 60_000)
    expect(sent).not.toHaveBeenCalled()

    sweepDueClocks(ctx, timers)
    expect(sent).toHaveBeenCalledWith('ap-1', 'allow')
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('fired')
  })

  it('leaves a clock that is still counting alone', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)

    sweepDueClocks(ctx, timers)
    expect(sent).not.toHaveBeenCalled()
    expect(ctx.state.autoApprove.deadlines['ap-1'].mode).toBe('running')
  })

  it('does nothing while the switch is off', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    disableClocks(ctx, timers)

    sweepDueClocks(ctx, timers)
    expect(sent).not.toHaveBeenCalled()
  })

  it('never re-fires a clock that already fired', () => {
    const timers: ClockTimers = new Map()
    const { ctx, sent } = makeCtx(true, [approval('ap-1')])
    syncClocks(ctx, timers)
    vi.advanceTimersByTime(FLOOR)

    sweepDueClocks(ctx, timers)
    expect(sent).toHaveBeenCalledOnce()
  })
})
