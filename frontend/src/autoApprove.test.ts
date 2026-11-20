import { describe, expect, it } from 'vitest'
import {
  AUTO_APPROVE_DEFAULTS,
  arm,
  armPlan,
  budgetMs,
  cancel,
  countWords,
  dueIds,
  isCancelled,
  markUntimed,
  remainingMs,
  secondsLabel,
  untimed,
  type Budgetable,
  type Deadline,
} from './autoApprove'

const NOW = 1_000_000
const approval = (id: string, what = '', why = ''): Budgetable => ({ id, what, why })
const words = (n: number) => Array(n).fill('word').join(' ')

describe('countWords', () => {
  it('counts whitespace-delimited words', () => {
    expect(countWords('Fix the typo')).toBe(3)
    expect(countWords('  spaced   out\n\ntext  ')).toBe(3)
  })

  it('treats missing and blank text as zero words', () => {
    expect(countWords(undefined)).toBe(0)
    expect(countWords('')).toBe(0)
    expect(countWords('   \n ')).toBe(0)
  })
})

describe('budgetMs', () => {
  it('floors a terse proposal at the minimum window', () => {
    // 2 + 1 words at 240wpm is ~0.75s — the floor is what protects this case.
    expect(budgetMs(approval('a', 'Fix typo', 'spelling'))).toBe(AUTO_APPROVE_DEFAULTS.floorMs)
  })

  it('is the floor until the prose exceeds the floor-equivalent word count', () => {
    const floorWords = (AUTO_APPROVE_DEFAULTS.floorMs / 60_000) * AUTO_APPROVE_DEFAULTS.wordsPerMinute
    expect(budgetMs(approval('a', words(floorWords - 10), ''))).toBe(AUTO_APPROVE_DEFAULTS.floorMs)
    expect(budgetMs(approval('a', words(floorWords + 20), ''))).toBeGreaterThan(AUTO_APPROVE_DEFAULTS.floorMs)
  })

  it('prices prose at the reading rate between floor and ceiling', () => {
    // 120 words at 240wpm = 30s.
    expect(budgetMs(approval('a', words(120), ''))).toBe(30_000)
    // 40 in `what` + 80 in `why` are counted together.
    expect(budgetMs(approval('a', words(40), words(80)))).toBe(30_000)
  })

  it('caps a rambling why so no agent can be stalled indefinitely', () => {
    expect(budgetMs(approval('a', '', words(5_000)))).toBe(AUTO_APPROVE_DEFAULTS.ceilingMs)
  })

  it('honours overridden constants', () => {
    const c = { wordsPerMinute: 240, floorMs: 30_000, ceilingMs: 180_000 }
    expect(budgetMs(approval('a', 'short', ''), c)).toBe(30_000)
  })

  it('gives every approval at least the floor, including an empty one', () => {
    for (const a of [approval('a'), approval('b', '', ''), approval('c', 'x')]) {
      expect(budgetMs(a)).toBe(AUTO_APPROVE_DEFAULTS.floorMs)
    }
  })
})

describe('cancel', () => {
  it('stops the countdown with no remainder to resume from', () => {
    expect(cancel()).toEqual({ mode: 'cancelled' })
  })

  it('is recognised by predicate as well as by mode', () => {
    expect(isCancelled(cancel())).toBe(true)
    expect(isCancelled({ mode: 'running', expiresAt: NOW })).toBe(false)
  })

  it('never becomes due, however long it sits', () => {
    expect(dueIds({ 'ap-1': cancel() }, NOW + 10 * 60_000)).toEqual([])
  })

  it('leaves nothing to render as a countdown', () => {
    expect(remainingMs(cancel(), NOW)).toBe(0)
  })
})

describe('remainingMs', () => {
  it('counts down a running clock', () => {
    const running = { mode: 'running', expiresAt: NOW + 8_000 } as const
    expect(remainingMs(running, NOW)).toBe(8_000)
    expect(remainingMs(running, NOW + 3_000)).toBe(5_000)
  })

  it('clamps at zero after expiry rather than going negative', () => {
    const running = { mode: 'running', expiresAt: NOW + 1_000 } as const
    expect(remainingMs(running, NOW + 9_000)).toBe(0)
  })
})

describe('dueIds', () => {
  it('returns only clocks that have expired', () => {
    const deadlines = {
      'ap-1': { mode: 'running', expiresAt: NOW - 1 } as const,
      'ap-2': { mode: 'running', expiresAt: NOW + 5_000 } as const,
      'ap-3': cancel(),
    }
    expect(dueIds(deadlines, NOW)).toEqual(['ap-1'])
  })

  it('is empty when nothing is armed', () => {
    expect(dueIds({}, NOW)).toEqual([])
  })
})

describe('armPlan', () => {
  it('arms a newly pending approval at a full budget', () => {
    const next = armPlan([approval('ap-1', 'Add guard', 'because')], {}, NOW)
    expect(next['ap-1']).toEqual({ mode: 'running', expiresAt: NOW + AUTO_APPROVE_DEFAULTS.floorMs })
  })

  it('keeps an existing clock so unrelated events cannot extend the window', () => {
    const existing = { 'ap-1': { mode: 'running', expiresAt: NOW + 1_500 } } as const
    const later = NOW + 2_000
    const next = armPlan([approval('ap-1', words(500), '')], existing, later)
    expect(next['ap-1']).toBe(existing['ap-1'])
  })

  it('drops approvals that are no longer pending', () => {
    const prev: Record<string, Deadline> = {
      'ap-1': { mode: 'running', expiresAt: NOW + 5_000 },
      'ap-2': { mode: 'running', expiresAt: NOW + 5_000 },
    }
    const next = armPlan([approval('ap-2')], prev, NOW)
    expect(Object.keys(next)).toEqual(['ap-2'])
  })

  it('keeps a cancelled clock cancelled across re-plans', () => {
    const prev: Record<string, Deadline> = { 'ap-1': cancel() }
    const next = armPlan([approval('ap-1', words(500), '')], prev, NOW + 60_000)
    expect(next['ap-1']).toEqual({ mode: 'cancelled' })
  })

  it('never restarts or invents a clock on a re-plan', () => {
    // Nothing in this module re-arms — enabling is markUntimed, so no re-plan
    // can hand an approval a countdown it did not already have.
    const prev: Record<string, Deadline> = {
      'ap-1': { mode: 'running', expiresAt: NOW + 1_000 },
      'ap-2': cancel(),
      'ap-3': untimed(),
    }
    const later = NOW + 60_000
    const next = armPlan([approval('ap-1', words(500), ''), approval('ap-2'), approval('ap-3')], prev, later)
    expect(next['ap-1']).toBe(prev['ap-1']) // the expired clock is left due — firing it is the timer's call
    expect(next['ap-2'].mode).toBe('cancelled')
    expect(next['ap-3'].mode).toBe('manual')
  })

  it('turns off by planning an empty clock map', () => {
    expect(armPlan([], { 'ap-1': arm(NOW, approval('ap-1')) }, NOW)).toEqual({})
  })
})

describe('markUntimed', () => {
  it('arms nothing — everything already waiting becomes untimed', () => {
    // The headline rule: flipping the switch on must not start a countdown
    // under an approval that did not have one.
    const next = markUntimed([approval('ap-1'), approval('ap-2')], {})
    expect(Object.values(next).every((deadline) => deadline.mode === 'manual')).toBe(true)
    expect(dueIds(next, NOW + 10 * 60_000)).toEqual([])
  })

  it('keeps a running clock and a cancellation exactly as they were', () => {
    const prev: Record<string, Deadline> = {
      'ap-1': { mode: 'running', expiresAt: NOW + 1_000 },
      'ap-2': cancel(),
    }
    const next = markUntimed([approval('ap-1'), approval('ap-2'), approval('ap-3')], prev)
    expect(next['ap-1']).toBe(prev['ap-1'])
    expect(next['ap-2'].mode).toBe('cancelled')
    expect(next['ap-3'].mode).toBe('manual')
  })

  it('drops approvals that are no longer pending, so the map cannot grow', () => {
    const prev: Record<string, Deadline> = { 'ap-1': cancel(), 'ap-2': cancel() }
    expect(Object.keys(markUntimed([approval('ap-2')], prev))).toEqual(['ap-2'])
  })
})

describe('secondsLabel', () => {
  it('labels sub-minute budgets as seconds', () => {
    expect(secondsLabel(5_000)).toBe('5s')
    expect(secondsLabel(59_000)).toBe('59s')
    expect(secondsLabel(59_400)).toBe('1m') // rounds up across the minute boundary
  })

  it('labels longer budgets as minutes and drops empty seconds', () => {
    expect(secondsLabel(75_000)).toBe('1m 15s')
    expect(secondsLabel(180_000)).toBe('3m')
  })

  it('never renders negative time', () => {
    expect(secondsLabel(-1_000)).toBe('0s')
  })
})
