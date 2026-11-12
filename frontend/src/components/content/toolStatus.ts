import type { ToolCall, ToolCallStatus } from '../../protocol'

/** Dot colour for a tool call's status — shared by the chat rail and the panel header. */
export function toolStatusDotClass(call: ToolCall): string {
  switch (call.status) {
    case 'running':
      return 'bg-accent animate-pulse'
    case 'error':
      return 'bg-danger'
    case 'done':
      return 'bg-ok'
    case 'pending_approval':
      return 'bg-warn animate-pulse'
    default:
      return 'bg-raised'
  }
}

/** The status word shown to the user. Only pending_approval reads differently from its id. */
export function formatToolStatus(status: ToolCallStatus): string {
  return status === 'pending_approval' ? 'pending approval' : status
}
