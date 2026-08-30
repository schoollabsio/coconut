/**
 * BackendClient — transport to the Go backend over Wails bindings.
 *
 * Wires the plan's §3.3.1 interface onto the Wails runtime:
 *   command()          → window.go.main.App.Command (envelope in/out)
 *   requestSnapshot()  → window.go.main.App.RequestSnapshot
 *   onMessage()        → window.runtime.EventsOn("backend", ...)
 *
 * A single ordered wails event channel carries every envelope, so the
 * global seq ordering from the backend is preserved end to end.
 */

import type { BackendMessage, CommandResponse, SnapshotMessage } from './protocol'
import { makeCommand } from './protocol'

declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          Command(reqJSON: string): Promise<string>
          RequestSnapshot(): Promise<string>
        }
      }
    }
    runtime?: {
      EventsOn(eventName: string, callback: (data: string) => void): () => void
    }
  }
}

export type UnsubscribeFn = () => void

export class BackendUnavailableError extends Error {
  constructor() {
    super('wails bindings unavailable (is the app running under wails dev/build?)')
    this.name = 'BackendUnavailableError'
  }
}

function appBinding() {
  const app = window.go?.main?.App
  if (!app) throw new BackendUnavailableError()
  return app
}

export class BackendClient {
  command<T = unknown>(name: string, payload?: unknown): Promise<CommandResponse<T>> {
    const app = appBinding()
    const cmd = makeCommand(name, payload)
    return app.Command(JSON.stringify(cmd)).then((raw) => JSON.parse(raw) as CommandResponse<T>)
  }

  async requestSnapshot(): Promise<SnapshotMessage> {
    const app = appBinding()
    const raw = await app.RequestSnapshot()
    return JSON.parse(raw) as SnapshotMessage
  }

  /** Subscribe to every backend envelope (event/stream/error). */
  onMessage(handler: (msg: BackendMessage) => void): UnsubscribeFn {
    const rt = window.runtime
    if (!rt) throw new BackendUnavailableError()
    return rt.EventsOn('backend', (data: string) => {
      try {
        handler(JSON.parse(data) as BackendMessage)
      } catch (err) {
        console.error('bad backend envelope', err)
      }
    })
  }
}
