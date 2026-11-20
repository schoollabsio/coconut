/**
 * Tail-follow state for a scroller that keeps streamed output in view.
 *
 * The question this answers is "did the *user* move away from the tail?", which is
 * NOT the same as "how far is the bottom edge right now?" — while text streams in,
 * the bottom edge is something *we* keep moving, so its distance is never evidence
 * about user intent.
 *
 * The bug this replaces: `scroll` events are delivered asynchronously (a frame or
 * more after we write `scrollTop`), and a handler always reads *live* geometry. So
 * the event our own pin queued gets measured against content that has since grown,
 * the distance-from-bottom reads large, and a box with no user interaction decides
 * the user scrolled away — permanently, since only a real scroll to the bottom
 * re-attaches. Recording where we pinned makes our own (late) event recognisable.
 */
import { isNearBottom } from './chatUtils'

/** Tolerance for browser `scrollTop` rounding (fractional layout / device-pixel snapping). */
const EPSILON_PX = 2

export interface TailFollow {
  /** Keep pinning the tail into view. */
  following: boolean
  /** The `scrollTop` we last wrote ourselves; null once the user takes over. */
  pinnedTop: number | null
}

/** A fresh follower starts attached to the tail (a streamed block starts unread). */
export function atTail(): TailFollow {
  return { following: true, pinnedTop: null }
}

/** The `scrollTop` that puts the tail flush with the bottom edge (0 when nothing overflows). */
export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight)
}

/** Record the position we just wrote: call after `el.scrollTop = maxScrollTop(...)`. */
export function afterPin(scrollHeight: number, clientHeight: number): TailFollow {
  return { following: true, pinnedTop: maxScrollTop(scrollHeight, clientHeight) }
}

/**
 * Resolve follow state from a `scroll` event, using the event target's own geometry.
 *
 * A scroll that leaves us at or below where we last pinned cannot have come from the
 * user: the bottom edge moved under us (text streamed in) and the browser delivered
 * our own write late. Only the user can be *above* the pin, so that case detaches.
 */
export function afterScroll(
  prev: TailFollow,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  slackPx: number,
): TailFollow {
  if (prev.pinnedTop !== null && scrollTop >= prev.pinnedTop - EPSILON_PX) return prev
  // Re/attaching drops the pin: a stale one must not re-attach the user early, and
  // the next growth records a fresh position anyway.
  return isNearBottom(scrollHeight, scrollTop, clientHeight, slackPx)
    ? { following: true, pinnedTop: null }
    : { following: false, pinnedTop: null }
}
