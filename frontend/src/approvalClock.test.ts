import { describe, expect, it } from 'vitest'
import { CLOCK_MANUAL_LABEL, CLOCK_SPENT_LABEL, clockView, runningCount } from './approvalClock'
import { AUTO_APPROVE_DEFAULTS, budgetMs } from './autoApprove'
import type { Budgetable } from './autoApprove'

const NOW = 1_000_000
const FLOOR = AUTO_APPROVE_DEFAULTS.floorMs
const approval: Budgetable = { id: 'ap-1', what: 'Fix typo', why: 'spelling' }

// budgetMs prices this two-word proposal at the floor, so the bar maths below is
// the same maths the timer armed with.

describe('clockView', () => {
  it('shows nothing while the switch is off', () => {
    expect(clockView(approval, { mode: 'running', expiresAt: NOW + FLOOR }, false, NOW)).toEqual({ kind: 'idle' })
  })

  it('shows nothing for an approval with no clock', () => {
    expect(clockView(approval, undefined, true, NOW)).toEqual({ kind: 'idle' })
  })

  it('reports a cancelled clock as spent, with no time to show', () => {
    expect(clockView(approval, { mode: 'cancelled' }, true, NOW)).toEqual({ kind: 'spent', label: CLOCK_SPENT_LABEL })
  })

  it('says so when the approval predates the switch and was never armed', () => {
    expect(clockView(approval, { mode: 'manual' }, true, NOW)).toEqual({ kind: 'manual', label: CLOCK_MANUAL_LABEL })
  })

  it('labels a running clock with the seconds it has left', () => {
    const view = clockView(approval, { mode: 'running', expiresAt: NOW + 5_000 }, true, NOW)
    expect(view).toEqual({ kind: 'running', label: 'auto-approves in 5s', percent: 100 })
  })

  it('drains the bar as the clock runs down', () => {
    const expires = NOW + FLOOR
    const mid = clockView(approval, { mode: 'running', expiresAt: expires }, true, NOW + FLOOR / 2)
    expect(mid).toEqual({ kind: 'running', label: 'auto-approves in 3s', percent: 50 })
    const late = clockView(approval, { mode: 'running', expiresAt: expires }, true, NOW + FLOOR - 100)
    expect(late).toEqual({ kind: 'running', label: 'auto-approves in 1s', percent: 2 })
  })

  it('says auto-approving once the budget is gone but the timer has not landed', () => {
    const view = clockView(approval, { mode: 'running', expiresAt: NOW - 1 }, true, NOW)
    expect(view).toEqual({ kind: 'running', label: 'auto-approving…', percent: 0 })
  })

  it('never shows more than full or less than empty', () => {
    const long = clockView(approval, { mode: 'running', expiresAt: NOW + FLOOR * 3 }, true, NOW)
    expect(long.kind === 'running' && long.percent).toBe(100)
    const short = clockView(approval, { mode: 'running', expiresAt: NOW - FLOOR * 3 }, true, NOW)
    expect(short.kind === 'running' && short.percent).toBe(0)
  })

  it('sizes the bar off the same budget the timer armed', () => {
    const view = clockView(approval, { mode: 'running', expiresAt: NOW + budgetMs(approval) / 4 }, true, NOW)
    expect(view.kind === 'running' && view.percent).toBe(25)
  })
})

describe('runningCount', () => {
  it('counts nothing when nothing is armed', () => {
    expect(runningCount({})).toBe(0)
  })

  it('counts the clocks still running, never a cancelled one', () => {
    const deadlines = {
      a: { mode: 'running', expiresAt: NOW } as const,
      b: { mode: 'cancelled' } as const,
      c: { mode: 'running', expiresAt: NOW + FLOOR } as const,
    }
    expect(runningCount(deadlines)).toBe(2)
  })
})
