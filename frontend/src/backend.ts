/**
 * BackendClient — transport to the Go backend over Wails v3 bindings.
 *
 * Wires the plan's §3.3.1 interface onto the Wails v3 runtime:
 *   command()          → App.Command (envelope in/out)
 *   requestSnapshot()  → App.RequestSnapshot
 *   onMessage()        → Events.On("backend", ...)
 *
 * A single ordered wails event channel carries every envelope, so the
 * global seq ordering from the backend is preserved end to end.
 *
 * v3 differences from v2:
 *   - bindings are generated ES modules (frontend/bindings/), not window.go.*
 *   - events use @wailsio/runtime: callbacks receive a WailsEvent {name, data};
 *     data is the structured envelope emitted by the backend
 */

import { App } from '../bindings/github.com/jschool/coconut/index.js'
import { Events } from '@wailsio/runtime'
import type { BackendMessage, CommandResponse, SnapshotMessage } from './protocol'
import { makeCommand } from './protocol'

export type UnsubscribeFn = () => void

/** TEMP (flicker diagnosis): fire-and-forget a diagnostics entry to the
 *  backend log (cmd diagnostics.log). Safe outside Wails (no-op). */
export function diagnose(kind: string, detail?: string) {
  try {
    void App.Command(JSON.stringify(makeCommand('diagnostics.log', { kind, detail: detail ?? '' })))
  } catch {
    /* not running under wails (e.g. tests) */
  }
}

export class BackendUnavailableError extends Error {
  constructor() {
    super('wails bindings unavailable (is the app running under wails dev/build?)')
    this.name = 'BackendUnavailableError'
  }
}

export class BackendClient {
  command<T = unknown>(name: string, payload?: unknown): Promise<CommandResponse<T>> {
    const cmd = makeCommand(name, payload)
    return App.Command(JSON.stringify(cmd)).then((raw) => JSON.parse(raw) as CommandResponse<T>)
  }

  async requestSnapshot(): Promise<SnapshotMessage> {
    const raw = await App.RequestSnapshot()
    return JSON.parse(raw) as SnapshotMessage
  }

  /** Subscribe to every backend envelope (event/stream/error).
   *  NOTE: v3 broadcasts custom events to ALL windows — the handler
   *  receives the sender (window name) and the store filters by its own
   *  windowName (learned from the snapshot). */
  onMessage(handler: (msg: BackendMessage, sender?: string) => void): UnsubscribeFn {
    if (!Events) throw new BackendUnavailableError()
    return Events.On('backend', (ev) => {
      try {
        handler(ev.data as BackendMessage, ev.sender)
      } catch (err) {
        console.error('bad backend envelope', err)
      }
    })
  }
}
