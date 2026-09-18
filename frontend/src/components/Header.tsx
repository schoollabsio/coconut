import { useEffect, useRef } from 'react'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import type { AgentSummary } from '../protocol'
import { store, useUIState } from '../store'
import { useAuthStatus } from '../useAuthStatus'

/** Header row: agent name + agent/session controls, workspace path (click
 *  to change), settings gear. */
export function Header({ client }: { client: BackendClient }) {
  const agentName = useUIState((s) => s.agentName)
  const workspace = useUIState((s) => s.workspace)
  const isFullscreen = useUIState((s) => s.isFullscreen)
  const authStatus = useAuthStatus(client)
  const inputRef = useRef<HTMLInputElement>(null)

  const fitName = () => {
    const el = inputRef.current
    if (el) el.size = Math.max(el.value.length, 4)
  }
  useEffect(fitName, [agentName])

  const commitName = () => {
    const name = inputRef.current?.value.trim() || 'Untitled Agent'
    if (name !== agentName) {
      store.setAgentNameLocal(name)
      void client.command(Cmd.AgentRename, { name })
    }
  }

  const pickWorkspace = () => {
    void client.command(Cmd.WorkspacePick, {})
  }

  const openAgents = async () => {
    const resp = await client.command<{ agents?: AgentSummary[] }>(Cmd.AgentList, {})
    if (resp.ok) store.openAgentPicker(resp.payload?.agents ?? [])
  }

  const resetSession = () => {
    void client.command(Cmd.AgentReset, {})
  }

  return (
    // pl-[76px]: the window's traffic-light buttons float over the top-left
    // (hidden titlebar). The strip itself drags the window (inherited from
    // the app root's drag-region); interactive elements opt out (no-drag).
    <div className={`flex items-center gap-2 pr-2 pt-1 pb-2 mb-1 ${isFullscreen ? 'pl-2' : 'pl-[76px]'}`}>
      <input
        ref={inputRef}
        defaultValue={agentName}
        key={agentName /* external renames reset the field */}
        spellCheck={false}
        aria-label="Agent name"
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        onInput={fitName}
        className="no-drag min-w-0 bg-transparent text-sm text-ink rounded-md px-1.5 py-0.5 border border-transparent hover:border-linestrong hover:bg-surface2 focus:border-linestrong focus:bg-surface2 outline-none transition-colors"
      />
      <button
        aria-label="Agents and sessions"
        title="Switch agent or open a previous session"
        onClick={openAgents}
        className="no-drag shrink-0 p-1 rounded-md text-dim hover:text-ink hover:bg-surface2 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <button
        aria-label="New session"
        title="New session (current transcript stays on disk)"
        onClick={resetSession}
        className="no-drag shrink-0 p-1 rounded-md text-dim hover:text-ink hover:bg-surface2 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 4v6h6M20 20v-6h-6M20 8.5A8 8 0 005.6 5.6L4 7m0 8.5A8 8 0 0018.4 18.4L20 17"
          />
        </svg>
      </button>
      <span className="h-3.5 w-px bg-surface2 shrink-0" />
      <button
        onClick={pickWorkspace}
        title={workspace ? `${workspace.path} — click to change` : 'Choose a workspace folder'}
        className="no-drag flex items-center gap-2 min-w-0 rounded-md px-1.5 py-0.5 hover:bg-surface2 transition-colors group"
      >
        <svg
          className="w-3.5 h-3.5 shrink-0 text-faint group-hover:text-mute"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
          />
        </svg>
        <span className="font-mono text-xs text-dim truncate max-w-[40vw] group-hover:text-mute">
          {workspace ? workspace.path : 'choose workspace…'}
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <AuthProviderChip status={authStatus} onClick={() => store.setSettingsOpen(true)} />
        <button
          aria-label="Open settings"
          onClick={() => store.setSettingsOpen(true)}
          className="no-drag shrink-0 p-1.5 rounded-lg text-dim hover:text-ink hover:bg-surface2 transition-colors"
        >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      </div>
    </div>
  )
}

/** Compact credential indicator: green dot when the active provider has
 *  credentials, dim otherwise. Click opens Settings → Provider. */
function AuthProviderChip({
  status,
  onClick,
}: {
  status: ReturnType<typeof useAuthStatus>
  onClick: () => void
}) {
  const active = status?.providers?.find((p) => p.id === status.activeProvider)
  const configured = !!active?.configured
  const label = active
    ? `${active.name || active.id}${configured ? '' : ' — not signed in'}`
    : 'no provider credentials'
  return (
    <button
      onClick={onClick}
      title={`${label} — click to manage in Settings → Provider`}
      className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface2 transition-colors"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${configured ? 'bg-accent' : 'bg-faint'}`}
      />
      <span className={`font-mono text-[10px] truncate max-w-[16vw] ${configured ? 'text-mute' : 'text-faint'}`}>
        {active ? active.name || active.id : 'no provider'}
      </span>
    </button>
  )
}
