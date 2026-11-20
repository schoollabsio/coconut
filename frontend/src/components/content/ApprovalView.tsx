import { BackendClient } from '../../backend'
import { Cmd, type ApprovalRequest } from '../../protocol'
import { store } from '../../store'
import { ApprovalClock } from '../ApprovalClock'
import { DiffView } from './DiffView'
import { Field, Meta, Prose } from './fields'

/**
 * A pending approval: what is proposed, why, the diff or the command, and the two
 * decisions. Both kinds share the What/Why header — only the body differs — and
 * `allow` / `dismiss` map onto the backend's approval decisions (⌘⏎ approves the
 * focused request; dismiss tells the agent in chat without retrying).
 */
export function ApprovalView({ approval, client }: { approval: ApprovalRequest; client: BackendClient }) {
  const respond = (decision: 'allow' | 'dismiss') => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId: approval.id, decision })
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      {approval.what && (
        <Field label="What" tone="warn">
          <Prose>{approval.what}</Prose>
        </Field>
      )}
      {approval.why && (
        <Field label="Why" tone="warn">
          <Meta>{approval.why}</Meta>
        </Field>
      )}

      {approval.kind === 'propose_edit' ? <EditBody diff={approval.diff} /> : <CommandBody command={approval.command} />}

      <div className="flex justify-end items-center gap-3">
        <ApprovalClock approval={approval} className="text-xs" />
        <button
          onClick={() => respond('dismiss')}
          title="Skip this for now — tell the agent what to change in chat"
          className="px-3 py-1.5 rounded-lg text-xs text-dim hover:text-mute hover:bg-surface2 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={() => respond('allow')}
          title="Approve (⌘+Return)"
          className="px-3 py-1.5 rounded-lg text-xs bg-ok hover:brightness-110 hover:bg-ok text-onaccent transition-colors"
        >
          Approve
        </button>
      </div>
    </div>
  )
}

/** A file approval: the unified diff the backend computed for the proposal. */
function EditBody({ diff }: { diff?: string }) {
  if (!diff) return null
  return (
    <Field label="Diff" tone="warn">
      <DiffView diff={diff} />
    </Field>
  )
}

/** A shell approval: the command, plus how to stop being asked about it. */
function CommandBody({ command }: { command?: string }) {
  return (
    <>
      <Field label="Command" tone="warn">
        <pre className="rounded-lg border border-line bg-base px-3 py-2.5 font-mono text-xs text-ink overflow-x-auto whitespace-pre-wrap">
          {command}
        </pre>
      </Field>
      <p className="text-xs text-dim mt-2">
        This command is not on the whitelist. Approve to run it once; approve similar commands automatically by extending
        the whitelist in settings.
      </p>
    </>
  )
}
