import { describe, expect, it } from 'vitest'
import { afterPin, afterScroll, atTail, maxScrollTop, type TailFollow } from './tailFollow'

// Geometry of the live thinking box: text-xs inside `max-h-[6em]` ⇒ a 72px viewport,
// line-height 1.45 ⇒ 17.4px per line, and a 24px slack — i.e. about 1.4 lines of
// streamed text is enough to move the bottom edge past the old distance-based check.
const CLIENT = 72
const SLACK = 24

/** Pin a freshly-grown box to the tail and return the resulting state. */
function pinnedAt(scrollHeight: number): TailFollow {
  return afterPin(scrollHeight, CLIENT)
}

/** Distance from the bottom edge, as the old predicate measured it. */
function distance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop - CLIENT
}

describe('maxScrollTop', () => {
  it('is the offset that puts the tail flush with the bottom', () => {
    expect(maxScrollTop(372, CLIENT)).toBe(300)
  })

  it('clamps to 0 when the content does not overflow', () => {
    expect(maxScrollTop(40, CLIENT)).toBe(0)
  })
})

describe('afterPin', () => {
  it('records where we wrote and stays attached', () => {
    expect(pinnedAt(372)).toEqual({ following: true, pinnedTop: 300 })
  })
})

describe('afterScroll', () => {
  it('keeps following when a late event reports our own pinned position', () => {
    // The regression: we pinned at 300 while scrollHeight was 372; text then grew
    // the box to 800, and the browser finally delivers our pin's scroll event.
    const pinned = pinnedAt(372)
    const next = afterScroll(pinned, 300, 800, CLIENT, SLACK)

    expect(distance(800, 300)).toBeGreaterThanOrEqual(SLACK) // the old check would detach here
    expect(next.following).toBe(true)
    expect(next).toBe(pinned) // unchanged: our own event is not evidence about the user
  })

  it('tolerates scrollTop rounding just below the pin', () => {
    const pinned = pinnedAt(800) // pinnedTop = 728
    expect(afterScroll(pinned, 728, 800, CLIENT, SLACK).following).toBe(true)
    expect(afterScroll(pinned, 726, 800, CLIENT, SLACK).following).toBe(true) // within the 2px epsilon
  })

  it('detaches when the user scrolls above the pin, and drops the pin', () => {
    const pinned = afterPin(800, CLIENT) // pinnedTop = 728
    const next = afterScroll(pinned, 400, 800, CLIENT, SLACK)

    expect(next).toEqual({ following: false, pinnedTop: null })
  })

  it('keeps the user detached as the tail keeps growing away from them', () => {
    const detached = afterScroll(afterPin(800, CLIENT), 400, 800, CLIENT, SLACK)
    expect(afterScroll(detached, 400, 1200, CLIENT, SLACK).following).toBe(false)
  })

  it('does not let a stale pin re-attach a user far above the new bottom', () => {
    // Pinned at 999 long ago (the box was smaller then), user scrolled up, the tail
    // grew to 1500: sitting at 999 is ~430px above the bottom, not "at the tail".
    const stale: TailFollow = { following: false, pinnedTop: 999 }
    expect(afterScroll(stale, 999, 1500, CLIENT, SLACK).following).toBe(false)
  })

  it('re-attaches when the user scrolls back to the bottom', () => {
    const detached = afterScroll(afterPin(800, CLIENT), 400, 800, CLIENT, SLACK)
    const next = afterScroll(detached, 728, 800, CLIENT, SLACK)

    expect(next.following).toBe(true)
    expect(next.pinnedTop).toBeNull() // the next growth records a fresh pin
  })

  it('treats a small upward scroll within the slack as staying at the tail', () => {
    // Slack is a *tolerance* now (it was the detach trigger before): 20px up of a
    // 728px pin, still within 24px of the bottom, keeps following.
    const pinned = afterPin(800, CLIENT)
    expect(afterScroll(pinned, 720, 800, CLIENT, SLACK).following).toBe(true)
  })

  it('attaches on a non-overflowing box where nothing can be scrolled', () => {
    const state = afterScroll(atTail(), 0, 40, CLIENT, SLACK)
    expect(state.following).toBe(true)
  })

  it('honours a larger slack, as the outer chat list uses', () => {
    const detached = { following: false, pinnedTop: null } as TailFollow
    // max scrollTop here is 1200 - 700 = 500; at 300 we are 200px above the bottom,
    // which the outer list's 120px slack does not cover.
    expect(afterScroll(detached, 300, 1200, 700, 120).following).toBe(false)
    // At 400 the distance is 100px: inside the outer list's 120px slack.
    expect(afterScroll(detached, 400, 1200, 700, 120).following).toBe(true)
  })
})
