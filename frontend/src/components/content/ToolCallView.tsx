import type { ToolCall } from '../../protocol'
import { Field, Meta, Prose } from './fields'
import { formatToolStatus, toolStatusDotClass } from './toolStatus'

/**
 * Detail view for a focused tool call: everything the chat rail row truncates.
 * Optional fields render only when present, so a read/grep call and a
 * propose_edit call each show their own shape.
 */
export function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      <Field label="Tool name">
        <Prose>{call.tool}</Prose>
      </Field>

      <Field label="Full label">
        <Meta>{call.label}</Meta>
      </Field>

      {call.path && (
        <Field label="Path">
          <Meta>{call.path}</Meta>
        </Field>
      )}

      {call.what && (
        <Field label="What">
          <Prose>{call.what}</Prose>
        </Field>
      )}

      {call.why && (
        <Field label="Why">
          <Meta>{call.why}</Meta>
        </Field>
      )}

      <Field label="Status">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${toolStatusDotClass(call)}`} />
          <span className="text-base text-ink leading-relaxed">{formatToolStatus(call.status)}</span>
        </div>
      </Field>

      {call.groupLabel && (
        <Field label="Group label">
          <Meta>{call.groupLabel}</Meta>
        </Field>
      )}
    </div>
  )
}
