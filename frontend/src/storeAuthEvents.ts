/**
 * auth.login.* event handlers — the single in-flight provider login flow
 * (PLAN.md §6, principle #6). Terminal events are guarded by loginId so a
 * stale flow can never clobber the live one.
 */
import { Ev } from './protocol'
import type { AuthLoginDonePayload, AuthLoginPromptEvent, AuthLoginStartPayload, AuthLoginStepPayload } from './protocol'
import type { AuthLoginFlow } from './storeState'
import type { EventCtx, EventHandler } from './storeEvents'

/** Update the login flow only when it is still the flow the event belongs to. */
function updateFlow(ctx: EventCtx, loginId: string | undefined, patch: (flow: AuthLoginFlow) => Partial<AuthLoginFlow>): void {
  const flow = ctx.state.auth.login
  if (!flow || !loginId || flow.loginId !== loginId) return
  ctx.set({ auth: { ...ctx.state.auth, login: { ...flow, ...patch(flow) } } })
}

/** Settle the flow into a terminal state, keeping its steps for the banner. */
function settle(result: AuthLoginFlow['result'], message?: string) {
  return () => ({ prompt: null, result, message })
}

export const AUTH_EVENT_HANDLERS: Record<string, EventHandler> = {
  [Ev.AuthLoginStarted]: (ctx, payload) => {
    ctx.beginAuthLogin(payload as AuthLoginStartPayload & { loginId: string })
  },

  [Ev.AuthLoginStep]: (ctx, payload) => {
    const sp = payload as AuthLoginStepPayload
    updateFlow(ctx, sp.loginId, (flow) => ({ steps: [...flow.steps, sp.event] }))
  },

  [Ev.AuthLoginPrompt]: (ctx, payload) => {
    const pp = payload as AuthLoginPromptEvent
    updateFlow(ctx, pp.loginId, () => ({ prompt: { promptId: pp.promptId, prompt: pp.prompt } }))
  },

  [Ev.AuthLoginCompleted]: (ctx, payload) => {
    const p = payload as AuthLoginDonePayload | undefined
    updateFlow(ctx, p?.loginId, settle('completed'))
  },

  [Ev.AuthLoginCancelled]: (ctx, payload) => {
    const p = payload as { loginId?: string; message?: string } | undefined
    updateFlow(ctx, p?.loginId, settle('cancelled', p?.message))
  },

  [Ev.AuthLoginFailed]: (ctx, payload) => {
    const p = payload as { loginId?: string; message?: string } | undefined
    updateFlow(ctx, p?.loginId, settle('failed', p?.message))
  },
}
