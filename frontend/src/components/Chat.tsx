import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BackendClient } from '../backend'
import { Cmd, type ChatMessage, type ToolCall } from '../protocol'
import { buildTimeline, type TimelineEntry } from '../timeline'
import { dismissPendingApprovals } from '../approvalActions'
import { store, useUIState } from '../store'
import type { ToolCallGroup } from '../toolGrouping'
import { Markdown } from './Markdown'
import { FadingTail, StreamingText } from './StreamingText'
import { buildRailPaths, type RailMeasure, type RailPath } from '../railGeometry'

/** Memoized markdown. The chat list re-renders on every token, but only
 *  the streaming message's text actually changes — memo lets every other
 *  block skip its full re-parse (previously every past message re-ran
 *  ReactMarkdown per token: the main flicker/jank source). */
const MemoMarkdown = memo(Markdown)

const MAX_INPUT_HEIGHT = 160

function formatThinkingDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
  const mins = Math.round(secs / 60)
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
}

type RailMarkerProps = {
  railKey: string
  spanClassName: string
  offsetClassName?: string
  children?: ReactNode
}
function RailMarker({ railKey, spanClassName, offsetClassName, children }: RailMarkerProps) {
  return (
    <div className={`rail w-[20px] shrink-0 flex items-baseline justify-center overflow-visible ${offsetClassName ?? ''}`}>
      {/* Zero-width strut: gives the rail cell a first-line baseline identical
          to the content cell's (row root carries the font metrics), so the
          badge can sit exactly on the text's x-height center. */}
      <span aria-hidden="true" className="w-0 select-none overflow-hidden opacity-0">
        x
      </span>
      <span data-rail-key={railKey} className={`${spanClassName} rail-marker-dot`}>
        {children}
      </span>
    </div>
  )
}

type RenderRow =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'thinking'; key: string; railKey: string; message: ChatMessage }
  | { kind: 'text'; key: string; railKey: string; message: ChatMessage }
  | { kind: 'tool'; key: string; railKey: string; call: ToolCall; lane: 'main' | 'child' }
  | { kind: 'group'; key: string; railKey: string; group: ToolCallGroup; expanded: boolean }
  | { kind: 'group-tool'; key: string; railKey: string; call: ToolCall; parentKey: string }

export function buildRailRows(timeline: TimelineEntry[], expandedGroups: Set<string>): RenderRow[] {
  const groupEntries = timeline.filter((entry): entry is Extract<TimelineEntry, { kind: 'group' }> => entry.kind === 'group')
  const groupIndexByKey = new Map<string, number>(groupEntries.map((group, index) => [group.key, index]))
  const rows: RenderRow[] = []

  for (const entry of timeline) {
    switch (entry.kind) {
      case 'user':
        rows.push({ kind: 'user', key: entry.key, message: entry.message })
        break
      case 'thinking':
        rows.push({ kind: 'thinking', key: entry.key, railKey: entry.key, message: entry.message })
        break
      case 'text':
        rows.push({ kind: 'text', key: entry.key, railKey: entry.key, message: entry.message })
        break
      case 'tool':
        rows.push({ kind: 'tool', key: entry.key, railKey: entry.key, call: entry.call, lane: 'main' })
        break
      case 'group': {
        const groupIndex = groupIndexByKey.get(entry.key) ?? -1
        const expanded = expandedGroups.has(entry.group.key) || groupIndex === groupEntries.length - 1
        rows.push({ kind: 'group', key: entry.key, railKey: entry.key, group: entry.group, expanded })
        if (expanded) {
          for (const call of entry.group.toolCalls) {
            rows.push({ kind: 'group-tool', key: call.id, railKey: call.id, call, parentKey: entry.group.key })
          }
        }
        break
      }
    }
  }

  return rows
}

function sameGroup(a: ToolCallGroup, b: ToolCallGroup): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.grouper === b.grouper &&
    a.toolCalls.length === b.toolCalls.length &&
    a.toolCalls.every((call, index) => call === b.toolCalls[index])
  )
}

/** A scroller is "near the bottom" when its distance from the bottom edge is
 *  under `thresholdPx`. The tall chat list passes a generous value; the
 *  compact thinking block uses the tighter default. Extracted for testing. */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, thresholdPx = 24): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx
}

type UserRowProps = { message: ChatMessage; sticky: boolean }
const UserRow = memo(function UserRow({ message, sticky }: UserRowProps) {
  return (
    <div className={sticky ? 'user-sticky' : 'pb-[12px]'} data-user-row-id={message.id}>
      <div className="user-row">
        <div className="user-bubble">{message.text}</div>
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message && prev.sticky === next.sticky)

type ThinkingRowProps = { railKey: string; message: ChatMessage }
const ThinkingRow = memo(function ThinkingRow({ railKey, message }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isDone = message.thinkingDone === true
  const thinking = message.thinking ?? ''
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow the tail only while the user is near the bottom of the block, so
  // scrolling up to read earlier thought isn't yanked back down (mirrors the
  // outer chat list's at-bottom guard).
  const atBottomRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight)
  }

  useLayoutEffect(() => {
    if (isDone) return
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [thinking, isDone])

  if (!thinking) return null

  if (!isDone) {
    return (
      <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[14px] text-xs leading-[1.45]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[10px] w-[10px] rounded-full border-2 border-dim bg-dim animate-pulse"
      />
        <div ref={scrollRef} onScroll={onScroll} className="min-w-0 max-h-[6em] overflow-y-auto whitespace-pre-wrap italic text-dim" style={{ scrollbarGutter: 'stable' }}>
          <FadingTail text={thinking} className="text-dim" />
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[14px] text-xs leading-[1.45]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[10px] w-[10px] rounded-full border-2 border-dim bg-surface2"
      />
      <div className="min-w-0">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="text-left italic text-dim transition-colors hover:text-mute">
          Thought for {message.thinkingMs != null ? formatThinkingDuration(message.thinkingMs) : 'a moment'}
        </button>
        {expanded && (
          <div className="mt-1 max-h-[10lh] overflow-y-auto whitespace-pre-wrap italic text-dim" style={{ scrollbarGutter: 'stable' }}>
            {thinking}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message)

type TextRowProps = { railKey: string; message: ChatMessage }
const TextRow = memo(function TextRow({ railKey, message }: TextRowProps) {
  const streaming = message.streaming ?? false
  return (
    <div className="grid grid-cols-[20px_1fr] gap-x-3 pb-[22px] text-sm leading-[1.5]">
      <RailMarker
        railKey={railKey}
        spanClassName="relative z-10 h-[10px] w-[10px] rounded-full border-2 border-accent bg-accent"
      />
      <div className="assistant-text min-w-0">
        {streaming ? <StreamingText text={message.text} /> : <MemoMarkdown text={message.text} />}
      </div>
    </div>
  )
}, (prev, next) => prev.message === next.message)

type ToolRowProps = {
  railKey: string
  call: ToolCall
  lane: 'main' | 'child'
  focused: boolean
}
const ToolRow = memo(function ToolRow({ railKey, call, lane, focused }: ToolRowProps) {
  const displayText = call.what || call.label
  const pending = call.status === 'pending_approval'
  const isRunning = call.status === 'running'
  const isError = call.status === 'error'

  const onClick = () => {
    if (pending) {
      store.focusApproval(call.approvalId ?? null)
      return
    }
    store.focusToolCall(call.id)
  }

  const rowClass = pending
    ? 'text-warn'
    : focused
      ? 'text-ink'
      : 'text-dim hover:text-mute'

  return (
    <button
      type="button"
      onClick={onClick}
      title={call.why || undefined}
      className={`${lane === 'child' ? 'flex pb-[14px]' : 'flex pb-[22px]'} group w-full items-start gap-x-3 rounded-[6px] py-1.5 text-left text-[13px] leading-[1.5] transition-colors cursor-pointer ${rowClass}`}
    >
      {lane === 'child' && <div className="w-[20px] shrink-0" />}
      <RailMarker
        railKey={railKey}
        spanClassName={`relative z-10 h-[10px] w-[10px] rounded-full border-2 ${isError ? 'border-danger bg-surface2' : 'border-info bg-surface2'} ${isRunning ? 'animate-pulse' : ''}`}
      />
      {isRunning && <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ok animate-pulse" />}
      {isError && <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />}
      <span className="min-w-0 flex-1 truncate">{displayText}</span>
      {!pending && (
        <span className={`ml-auto shrink-0 text-[11px] text-faint transition-opacity ${focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          ⤢ detail
        </span>
      )}
    </button>
  )
}, (prev, next) => prev.call === next.call && prev.lane === next.lane && prev.focused === next.focused)

type ApprovalCardRowProps = {
  railKey: string
  lane: 'main' | 'child'
  approvalId: string
  kind: 'propose_edit' | 'bash'
  what?: string
  why?: string
  command?: string
  focused: boolean
  client: BackendClient
}
const ApprovalCardRow = memo(function ApprovalCardRow({
  railKey,
  lane,
  approvalId,
  kind,
  what,
  why,
  command,
  focused,
  client,
}: ApprovalCardRowProps) {
  const approve = () => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId, decision: 'allow' })
  }
  const dismiss = () => {
    store.focusApproval(null)
    void client.command(Cmd.ApprovalRespond, { approvalId, decision: 'dismiss' })
  }

  const gridClass = lane === 'child' ? 'grid grid-cols-[20px_20px_1fr] gap-x-3 pb-[8px] leading-[1.45]' : 'grid grid-cols-[20px_1fr] gap-x-3 pb-[8px] leading-[1.45]'
  const detailsLabel = kind === 'propose_edit' ? 'full diff ⤢' : 'details ⤢'

  return (
    <div className={gridClass}>
      {lane === 'child' && <div className="rail none" />}
      <div className="rail flex justify-center overflow-visible pt-[16px]">
        <span data-rail-key={railKey} className="rail-marker-dot relative z-10 h-[10px] w-[10px] rounded-full border-2 border-warn bg-warn animate-pulse" />
      </div>
      <div className={`approval min-w-0 ${focused ? 'ring-1 ring-[rgba(217,160,91,.22)]' : ''}`}>
        <div className="k">Approval needed · {kind}</div>
        {what && <div className="what">{what}</div>}
        {why && <div className="why">{why}</div>}
        {kind === 'bash' && command && <pre className="command">{command}</pre>}
        <div className="actions">
          <button type="button" onClick={approve} title="Approve (⌘+Return)" className="btn-approve">
            Approve
          </button>
          <button type="button" onClick={dismiss} className="btn-dismiss">
            Dismiss
          </button>
          <button type="button" onClick={() => store.focusApproval(approvalId)} className="details-link">
            {detailsLabel}
          </button>
        </div>
        <div className="hint">or just type a reply below — sending a message dismisses this request</div>
      </div>
    </div>
  )
}, (prev, next) =>
  prev.railKey === next.railKey &&
  prev.lane === next.lane &&
  prev.approvalId === next.approvalId &&
  prev.kind === next.kind &&
  prev.what === next.what &&
  prev.why === next.why &&
  prev.command === next.command &&
  prev.focused === next.focused &&
  prev.client === next.client)

type GroupRowProps = {
  railKey: string
  group: ToolCallGroup
  expanded: boolean
}
const GroupRow = memo(function GroupRow({ railKey, group, expanded }: GroupRowProps) {
  return (
    <button
      type="button"
      onClick={() => store.toggleGroup(group.key)}
      className={`grid w-full grid-cols-[20px_1fr] gap-x-3 rounded-[6px] text-left text-[13.5px] leading-[1.4] transition-colors ${expanded ? 'pb-[14px]' : 'pb-[22px]'}`}
    >
      <RailMarker
        railKey={railKey}
        spanClassName="rail-marker-branch relative z-10 flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-info bg-base text-info"
      >
        <span className="text-[9px] leading-none">⎇</span>
      </RailMarker>
      <div className="flex items-baseline gap-2">
        <span className={`font-medium ${expanded ? 'text-ink' : 'italic text-dim'}`}>{group.label}</span>
        <span className="text-[11px] text-faint">{group.toolCalls.length} calls</span>
      </div>
    </button>
  )
}, (prev, next) => sameGroup(prev.group, next.group) && prev.expanded === next.expanded)

type RailOverlayProps = {
  rows: RenderRow[]
  paths: RailPath[]
}
function RailOverlay({ rows, paths }: RailOverlayProps) {
  if (rows.length === 0 || paths.length === 0) return null
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
      {paths.map((path, index) => (
        <path
          key={`${path.kind}-${index}-${path.d}`}
          d={path.d}
          fill="none"
          stroke={path.kind === 'curve' ? 'var(--color-linestrong)' : 'var(--color-line)'}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

export function Chat({ client }: { client: BackendClient }) {
  const messages = useUIState((s) => s.agent.messages)
  const toolCalls = useUIState((s) => s.agent.toolCalls)
  const status = useUIState((s) => s.agent.status)
  const pendingApprovals = useUIState((s) => s.pendingApprovals)
  const focusedApprovalId = useUIState((s) => s.focusedApprovalId)
  const focusedToolCallId = useUIState((s) => s.focusedToolCallId)
  const expandedGroups = useUIState((s) => s.expandedGroups)
  const busy = status !== 'idle' && status !== 'error'

  const timeline = useMemo(() => buildTimeline(messages, toolCalls), [messages, toolCalls])
  const railRows = useMemo(() => buildRailRows(timeline, expandedGroups), [timeline, expandedGroups])
  const approvalById = useMemo(() => new Map(pendingApprovals.map((a) => [a.id, a])), [pendingApprovals])
  const lastMsg = messages[messages.length - 1]
  const latestUserId = useMemo(() => {
    for (let i = railRows.length - 1; i >= 0; i--) {
      const row = railRows[i]
      if (row.kind === 'user') return row.key
    }
    return null
  }, [railRows])
  const hasLiveThinking = timeline.some((entry) => entry.kind === 'thinking' && !entry.message.thinkingDone)

  const chatRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [railPaths, setRailPaths] = useState<RailPath[]>([])
  const railSigRef = useRef('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')

  const measureRail = useCallback(() => {
    const root = contentRef.current
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    const positions: Record<string, RailMeasure> = {}

    root.querySelectorAll<HTMLElement>('[data-rail-key]').forEach((el) => {
      const key = el.dataset.railKey
      if (!key) return
      const rect = el.getBoundingClientRect()
      positions[key] = {
        x: rect.left - rootRect.left + rect.width / 2,
        top: rect.top - rootRect.top,
        bottom: rect.bottom - rootRect.top,
      }
    })

    const next = buildRailPaths(railRows, positions)
    const sig = next.map((p) => `${p.kind}:${p.d}`).join('|')
    if (sig !== railSigRef.current) {
      railSigRef.current = sig
      setRailPaths(next)
    }
  }, [railRows])

  useLayoutEffect(() => {
    measureRail()
    const root = contentRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measureRail())
    ro.observe(root)
    return () => ro.disconnect()
  }, [measureRail])

  // Follow the bottom only while the user is already near the bottom.
  const atBottomRef = useRef(true)
  const pendingPinRef = useRef(false)
  const pinnedUserIdRef = useRef<string | null>(null)
  const onScroll = () => {
    const el = chatRef.current
    if (!el) return
    atBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight, 120)
  }
  useLayoutEffect(() => {
    if (!pendingPinRef.current || !latestUserId || latestUserId === pinnedUserIdRef.current) return
    const scroller = chatRef.current
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-user-row-id="${latestUserId}"]`)
    if (!scroller || !row) return
    const nextTop = row.offsetTop
    scroller.scrollTop = nextTop
    atBottomRef.current = false
    pendingPinRef.current = false
    pinnedUserIdRef.current = latestUserId
  }, [latestUserId])
  useEffect(() => {
    const el = chatRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [timeline, busy, expandedGroups])

  const autoresize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px'
  }

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pendingPinRef.current = true
    atBottomRef.current = false
    requestAnimationFrame(autoresize)
    await dismissPendingApprovals(client, pendingApprovals)
    const resp = await client.command(Cmd.AgentStart, { prompt: text })
    if (!resp.ok) {
      pendingPinRef.current = false
      console.error('agent.start failed', resp.error)
    }
  }

  const cancel = () => {
    void client.command(Cmd.AgentCancel, {})
  }

  return (
    <>
      <div ref={chatRef} onScroll={onScroll} className="max-h-96 overflow-y-auto pr-2 text-base md:max-h-none md:flex-1">
        <div ref={contentRef} className="relative min-h-full">
          <RailOverlay rows={railRows} paths={railPaths} />
          <div className="relative z-10 flex flex-col">
            {railRows.length === 0 && <div className="px-2 pt-4 text-sm italic text-faint">No messages yet — ask the agent anything.</div>}

            {railRows.map((row) => {
              if (row.kind === 'user') {
                return <UserRow key={row.key} message={row.message} sticky={row.key === latestUserId} />
              }
              if (row.kind === 'thinking') {
                return <ThinkingRow key={row.key} railKey={row.railKey} message={row.message} />
              }
              if (row.kind === 'text') {
                return <TextRow key={row.key} railKey={row.railKey} message={row.message} />
              }
              if (row.kind === 'tool') {
                const approval = row.call.approvalId ? approvalById.get(row.call.approvalId) : undefined
                if (row.call.status === 'pending_approval' && approval) {
                  return (
                    <ApprovalCardRow
                      key={row.key}
                      railKey={row.railKey}
                      lane={row.lane}
                      approvalId={approval.id}
                      kind={approval.kind}
                      what={approval.what || approval.title}
                      why={approval.why}
                      command={approval.command}
                      focused={focusedApprovalId === approval.id}
                      client={client}
                    />
                  )
                }
                return <ToolRow key={row.key} railKey={row.railKey} call={row.call} lane={row.lane} focused={focusedToolCallId === row.call.id} />
              }
              if (row.kind === 'group') {
                return <GroupRow key={row.key} railKey={row.railKey} group={row.group} expanded={row.expanded} />
              }
              if (row.kind === 'group-tool') {
                const approval = row.call.approvalId ? approvalById.get(row.call.approvalId) : undefined
                if (row.call.status === 'pending_approval' && approval) {
                  return (
                    <ApprovalCardRow
                      key={row.key}
                      railKey={row.railKey}
                      lane="child"
                      approvalId={approval.id}
                      kind={approval.kind}
                      what={approval.what || approval.title}
                      why={approval.why}
                      command={approval.command}
                      focused={focusedApprovalId === approval.id}
                      client={client}
                    />
                  )
                }
                return <ToolRow key={row.key} railKey={row.railKey} call={row.call} lane="child" focused={focusedToolCallId === row.call.id} />
              }
              return null
            })}

            {busy && !lastMsg?.streaming && !hasLiveThinking &&
              (status === 'awaiting_tool_approval' ? (
                <span className="mt-1 text-sm italic text-dim subtle-pulse">waiting for your approval…</span>
              ) : (
                <span className="mt-1 flex items-center gap-2 text-sm italic text-dim">
                  <svg className="h-3.5 w-3.5 animate-spin text-dim" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Generating…
                </span>
              ))}
          </div>
        </div>
      </div>

      <form
        className="mt-3 flex items-center gap-2 rounded-3xl bg-surface2 px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder="Ask a follow-up…"
          aria-label="Message the agent"
          onChange={(e) => {
            setDraft(e.target.value)
            autoresize()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-base leading-loose text-ink outline-none placeholder-faint"
        />
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Stop the agent"
            title="Stop the agent"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised text-mute transition-colors hover:bg-danger/80 hover:text-onaccent"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-onaccent transition-colors hover:bg-accenthover"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m-7 7l7-7 7 7" />
            </svg>
          </button>
        )}
      </form>
    </>
  )
}
