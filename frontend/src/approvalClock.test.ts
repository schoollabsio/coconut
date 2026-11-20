import { describe, expect, it } from 'vitest'
import {
  CLOCK_FIRED_LABEL,
  CLOCK_MANUAL_LABEL,
  CLOCK_SPENT_LABEL,
  clockView,
  runningCount,
} from './approvalClock'
import { AUTO_APPROVE_DEFAULTS, arm, type Deadline } from './autoApprove'

const NOW = 1_000_000
const FLOOR = AUTO_APPROVE_DEFAULTS.floorMs
/** Terse prose, so budgetMs() would price this at the floor — handy for proving
 *  the bar does NOT read the approval at all. */
const approval = { id: 'ap-1', what: 'Fix typo', why: 'spelling' }

const clock = (expiresAt: number, totalMs = FLOOR): Deadline => ({ mode: 'running', expiresAt, totalMs })

describe('clockView', () => {
  it('shows nothing while the switch is off', () => {
    expect(clockView(clock(NOW + FLOOR), false, NOW)).toEqual({ kind: 'idle' })
  })

  it('shows nothing for an approval with no clock', () => {
    expect(clockView(undefined, true, NOW)).toEqual({ kind: 'idle' })
  })

  it('reports a fired clock as auto-approved, never as cancelled', () => {
    // The user did not take this decision back, and the old wording said they
    // did — while dropping the bar mid-drain at whatever was left.
    expect(clockView({ mode: 'fired' }, true, NOW)).toEqual({ kind: 'fired', label: CLOCK_FIRED_LABEL })
  })

  it('reports a cancelled clock as spent, with no time to show', () => {
    expect(clockView({ mode: 'cancelled' }, true, NOW)).toEqual({ kind: 'spent', label: CLOCK_SPENT_LABEL })
  })

  it('says so when the approval predates the switch and was never armed', () => {
    expect(clockView({ mode: 'manual' }, true, NOW)).toEqual({ kind: 'manual', label: CLOCK_MANUAL_LABEL })
  })

  it('labels a running clock with the seconds it has left', () => {
    expect(clockView(clock(NOW + 5_000), true, NOW)).toEqual({
      kind: 'running',
      label: 'auto-approves in 5s',
      percent: 100,
      totalMs: 5_000,
      leftMs: 5_000,
    })
  })

  it('drains the bar as the clock runs down', () => {
    const expires = NOW + FLOOR
    const mid = clockView(clock(expires), true, NOW + FLOOR / 2)
    expect(mid).toMatchObject({ label: 'auto-approves in 3s', percent: 50, leftMs: FLOOR / 2 })
    const late = clockView(clock(expires), true, NOW + FLOOR - 100)
    expect(late).toMatchObject({ label: 'auto-approves in 1s', percent: 2, leftMs: 100 })
  })

  it('says auto-approving once the budget is gone but the timer has not landed', () => {
    expect(clockView(clock(NOW - 1), true, NOW)).toEqual({
      kind: 'running',
      label: 'auto-approving…',
      percent: 0,
      totalMs: FLOOR,
      leftMs: 0,
    })
  })

  it('never shows more than full or less than empty', () => {
    expect(clockView(clock(NOW + FLOOR * 3), true, NOW)).toMatchObject({ percent: 100 })
    expect(clockView(clock(NOW - FLOOR * 3), true, NOW)).toMatchObject({ percent: 0 })
  })

  it('sizes the bar off the budget the deadline was armed with', () => {
    // The approval's own prose would price at the floor; the deadline says
    // 20s, and the deadline wins — that is the number the timer will honour.
    const view = clockView(clock(NOW + 10_000, 20_000), true, NOW)
    expect(view).toMatchObject({ percent: 50, totalMs: 20_000, leftMs: 10_000 })
  })

  describe('at a non-second-aligned instant (the bar-fires-early regression)', () => {
    // Every other `now` in this file is second-aligned — the one phase where a
    // floored "now" was invisible. A card armed 900ms into a second used to
    // advertise 6s of a 5s budget and still show 18% when the timer fired.
    const armedAt = NOW + 900
    const deadline = arm(armedAt, approval)

    it('never advertises more than the budget it was armed with', () => {
      expect(clockView(deadline, true, armedAt)).toMatchObject({ label: 'auto-approves in 5s', percent: 100 })
    })

    it('is empty at the instant the timer fires', () => {
      const fires = deadline.mode === 'running' ? deadline.expiresAt : NOW
      expect(clockView(deadline, true, fires)).toMatchObject({ percent: 0, leftMs: 0 })
    })

    it('never over-reports the time left at any point in the countdown', () => {
      // The displayed ms must never exceed what the timer actually has left.
      for (let step = 0; step <= FLOOR; step += 37) {
        const at = armedAt + step
        const view = clockView(deadline, true, at)
        if (view.kind !== 'running') throw new Error(`clock stopped reading at ${step}ms`)
        expect(view.leftMs).toBe(Math.max(0, FLOOR - step))
      }
    })
  })
})

describe('runningCount', () => {
  it('counts nothing when nothing is armed', () => {
    expect(runningCount({})).toBe(0)
  })

  it('counts the clocks still running, never a spent one', () => {
    const deadlines = {
      a: clock(NOW),
      b: { mode: 'cancelled' } as const,
      c: clock(NOW + FLOOR),
      d: { mode: 'fired' } as const,
      e: { mode: 'manual' } as const,
    }
    expect(runningCount(deadlines)).toBe(2)
  })
})
