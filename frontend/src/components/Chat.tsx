import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BackendClient } from '../backend'
import { Cmd } from '../protocol'
import { useUIState } from '../store'
import { dismissPendingApprovals } from '../approvalActions'
import { buildTimeline } from '../timeline'
import { buildRailPaths, type RailMeasure, type RailPath } from '../railGeometry'
import { ChatForm } from './chat/ChatForm'
import { ChatList } from './chat/ChatList'
import { buildRailRows } from './chat/chatUtils'
import { useTailFollow } from './chat/useTailFollow'

/** Distance from the bottom treated as "still at the tail" — a tolerance for the
 *  user's own scrolling, not a detach trigger (streaming invalidates distance). */
const FOLLOW_THRESHOLD_PX = 120

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

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [railPaths, setRailPaths] = useState<RailPath[]>([])
  const railSigRef = useRef<string>('')
  const [draft, setDraft] = useState<string>('')

  // Rail bullets are positioned by the rows themselves, so the connector
  // geometry has to be measured from the DOM after layout.
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

  const pendingPinRef = useRef(false)
  const pinnedUserIdRef = useRef<string | null>(null)
  // The timeline follows the tail while we own it; scrolling up detaches until the
  // user comes back down. The slack is generous because a prompt pinned at the top
  // deliberately leaves the tail off-screen, and because neither live scroller lets
  // scroll anchoring write scrollTop beside us (see ChatList).
  const { onScroll, detach } = useTailFollow(scrollRef, contentRef, { slackPx: FOLLOW_THRESHOLD_PX })

  // Re-pin the newest prompt to the top of the viewport once, right after it
  // lands, so the answer grows downward instead of pushing the question away.
  // Ours deliberately steps off the tail, hence detach().
  useLayoutEffect(() => {
    if (!pendingPinRef.current || !latestUserId || latestUserId === pinnedUserIdRef.current) return
    const scroller = scrollRef.current
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-user-row-id="${latestUserId}"]`)
    if (!scroller || !row) return
    scroller.scrollTop = row.offsetTop
    detach()
    pendingPinRef.current = false
    pinnedUserIdRef.current = latestUserId
  }, [latestUserId, detach])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pendingPinRef.current = true
    detach()
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
      <ChatList
        client={client}
        railRows={railRows}
        railPaths={railPaths}
        latestUserId={latestUserId}
        focusedApprovalId={focusedApprovalId}
        focusedToolCallId={focusedToolCallId}
        approvalById={approvalById}
        status={status}
        lastMsg={lastMsg}
        hasLiveThinking={hasLiveThinking}
        busy={busy}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onScroll={onScroll}
      />
      <ChatForm draft={draft} setDraft={setDraft} busy={busy} onSend={send} onCancel={cancel} />
    </>
  )
}

