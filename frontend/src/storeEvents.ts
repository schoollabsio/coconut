/**
 * Backend event → store-state dispatch (PLAN.md §8).
 *
 * `UIStore.applyEvent` keeps sequencing (drop duplicates, resync on a seq gap)
 * and delegates the domain mutation here, grouped by domain so each table stays
 * small instead of one giant switch. Handlers receive an `EventCtx` — the slice
 * of the store they actually touch — and stay pure with respect to the rest.
 */
import type { AuthLoginStartPayload } from './protocol'
import type { Notification, UIState } from './storeState'
import { AGENT_EVENT_HANDLERS, APPROVAL_EVENT_HANDLERS } from './storeAgentEvents'
import { AUTH_EVENT_HANDLERS } from './storeAuthEvents'
import { CONTENT_EVENT_HANDLERS, SESSION_EVENT_HANDLERS } from './storeContentEvents'

/** The slice of UIStore an event handler may use. UIStore satisfies it
 *  structurally (`implements EventCtx`) and passes itself as `this`. */
export interface EventCtx {
  state: UIState
  /** Patch top-level state (notifies listeners). */
  set(patch: Partial<UIState>): void
  /** Patch the agent slice (notifies listeners). */
  setAgent(patch: Partial<UIState['agent']>): void
  pushNotification(level: Notification['level'], message: string): void
  beginAuthLogin(payload: AuthLoginStartPayload & { loginId: string }): void
  /** Re-derive the auto-approve clocks from the new pending set: arm what is
   *  new, keep what is running, drop what is resolved. No-op while off. */
  syncClocks(): void
  /** Ids finalized by `agent.message.appended`; guards late stream flushes. */
  finalized: Set<string>
  /** Ask the bootstrapper for a fresh snapshot (history rebuilt behind us). */
  resync: (() => void) | null
}

export type EventHandler = (ctx: EventCtx, payload: unknown) => void

/** Event name → handler. Names missing here carry no client-side state. */
export const EVENT_HANDLERS: Record<string, EventHandler> = {
  ...AGENT_EVENT_HANDLERS,
  ...APPROVAL_EVENT_HANDLERS,
  ...CONTENT_EVENT_HANDLERS,
  ...SESSION_EVENT_HANDLERS,
  ...AUTH_EVENT_HANDLERS,
}
