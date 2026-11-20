/**
 * Tail-follow wiring for a scroller that keeps streamed output in view.
 *
 * Two things go wrong when such a box pins with `scrollTop = scrollHeight` and
 * decides whether to keep doing so from its distance to the bottom:
 *
 *  - `scroll` events are delivered asynchronously. The event our own pin queued
 *    gets handled against geometry that has since grown, so the distance reads
 *    large and the box concludes the user scrolled away with no interaction at
 *    all — and only a real scroll to the bottom re-attaches it.
 *  - Streamed text lands *after* the commit our pin runs in (`FadingTail` appends
 *    its chunk post-paint), so there is always a line of distance available to
 *    misread, and the tail trails by a chunk.
 *
 * So the decision is delegated to tailFollow.ts (intent, not distance) and the
 * pin is driven by *growth*: after every commit, plus a ResizeObserver on the
 * content — which catches the deferred append, re-wrap, resize and font changes,
 * from whatever source they come.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject, UIEvent } from 'react'
import { afterPin, afterScroll, atTail, maxScrollTop } from './tailFollow'

/** Distance from the bottom still treated as "at the tail" (a tolerance, not a
 *  detach trigger): absorbs a small scroll-up and browser scrollTop rounding. */
const DEFAULT_SLACK_PX = 24

/** A ref to a live element; structural so `RefObject<HTMLDivElement>` fits. */
type ElementRef = RefObject<HTMLElement | null>

export interface TailFollowOptions {
  /** Stop following once the streamed block is done (the live box unmounts). */
  enabled?: boolean
  /** Slack for "the user is still at the tail"; the chat list wants it generous. */
  slackPx?: number
}

export interface TailFollowBinding {
  /** Wire to the scroller's `onScroll`. */
  onScroll: (event: UIEvent<HTMLElement>) => void
  /** Pin to the tail now, if we still own it. */
  pin: () => void
  /** Move away from the tail on purpose (e.g. re-anchoring to a new prompt). */
  detach: () => void
}

export function useTailFollow(
  scrollRef: ElementRef,
  contentRef: ElementRef,
  options: TailFollowOptions = {},
): TailFollowBinding {
  const { enabled = true, slackPx = DEFAULT_SLACK_PX } = options
  const follow = useRef(atTail())

  const pin = useCallback(() => {
    const el = scrollRef.current
    if (!el || !follow.current.following) return
    el.scrollTop = maxScrollTop(el.scrollHeight, el.clientHeight)
    follow.current = afterPin(el.scrollHeight, el.clientHeight)
  }, [scrollRef])

  // Read geometry off the event target, never a ref: a scroll event tells us about
  // the element that moved, and this handler must not judge another scroller.
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const el = event.currentTarget
      follow.current = afterScroll(follow.current, el.scrollTop, el.scrollHeight, el.clientHeight, slackPx)
    },
    [slackPx],
  )

  const detach = useCallback(() => {
    follow.current = { following: false, pinnedTop: null }
  }, [])

  // The new text may already be in this commit; pin then rather than after paint
  // (no visible jump). Runs unconditionally — the content is what changed, and
  // pin() no-ops while detached. Cheap: one scrollHeight read per commit.
  useLayoutEffect(pin)

  useLayoutEffect(() => {
    const body = contentRef.current
    if (!enabled || !scrollRef.current || !body || typeof ResizeObserver === 'undefined') return
    // Growth also arrives *after* this commit (FadingTail's post-paint append), so
    // watch the content box — the scroller's own box is capped by `max-h` and
    // would never report it.
    const observer = new ResizeObserver(() => pin())
    observer.observe(body)
    return () => observer.disconnect()
  }, [enabled, pin, scrollRef, contentRef])

  return { onScroll, pin, detach }
}
