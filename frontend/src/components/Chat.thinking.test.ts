import { describe, expect, it } from 'vitest'
import { isNearBottom } from './Chat'

describe('isNearBottom', () => {
  it('is true at the very bottom', () => {
    // scrollHeight 500, clientHeight 200 -> scrolled to bottom = scrollTop 300
    expect(isNearBottom(500, 300, 200)).toBe(true)
  })

  it('is true when within the default threshold', () => {
    // distance from bottom = 500 - 280 - 200 = 20 (< 24)
    expect(isNearBottom(500, 280, 200)).toBe(true)
  })

  it('is false when scrolled up beyond the default threshold', () => {
    // distance from bottom = 500 - 250 - 200 = 50 (>= 24)
    expect(isNearBottom(500, 250, 200)).toBe(false)
  })

  it('treats exactly-at-threshold as "not near" (strict less-than)', () => {
    // distance from bottom = 500 - 276 - 200 = 24 (== 24, not < 24)
    expect(isNearBottom(500, 276, 200)).toBe(false)
  })

  it('honours a larger threshold (as the chat list does)', () => {
    // distance from bottom = 500 - 350 - 200 = 50 (< 120)
    expect(isNearBottom(500, 350, 200, 120)).toBe(true)
  })

  it('is true when content does not overflow (nothing to scroll)', () => {
    // scrollHeight == clientHeight -> distance 0
    expect(isNearBottom(200, 0, 200)).toBe(true)
  })
})
