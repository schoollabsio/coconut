import { useEffect, useRef, useState, type ReactNode } from 'react'

const MIN_FR = 0.5
const CLICK_THRESHOLD = 4 // px before a press becomes a drag

/**
 * The 2-column resizable/collapsible grid from the mockup:
 * [chat | handle | content]. The handle resizes the panels; clicking it
 * collapses / expands the content side.
 */
export function ColumnGrid(props: { chat: ReactNode; content: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState([3, 2])
  const [contentCollapsed, setContentCollapsed] = useState(false)
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    const grid = gridRef.current
    if (!grid) return

    const startX = e.clientX
    const startWidths = [...widths]
    const canDrag = !contentCollapsed
    let moved = false

    const handleSpace = 12
    const totalFr = widths.reduce((sum, w, i) => sum + (i === 1 && contentCollapsed ? 0 : w), 0)
    const pxPerFr = (grid.clientWidth - handleSpace) / totalFr

    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('select-none')
    if (canDrag) document.body.classList.add('cursor-col-resize')

    const onMove = (ev: PointerEvent) => {
      if (!canDrag) return
      if (!moved && Math.abs(ev.clientX - startX) < CLICK_THRESHOLD) return
      moved = true
      const deltaFr = (ev.clientX - startX) / pxPerFr
      let d = Math.max(deltaFr, -(startWidths[0] - MIN_FR))
      d = Math.min(d, startWidths[1] - MIN_FR)
      const next = [...startWidths]
      next[0] = startWidths[0] + d
      next[1] = startWidths[1] - d
      setWidths(next)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      document.body.classList.remove('select-none', 'cursor-col-resize')
      if (!moved) {
        setContentCollapsed((v) => !v)
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp, { once: true })
    handle.addEventListener('pointercancel', onUp, { once: true })
  }

  const gridStyle: React.CSSProperties = {}
  if (isDesktop) {
    const [chatFr, contentFr] = widths
    gridStyle.gridTemplateColumns = `minmax(0, ${chatFr}fr) 12px minmax(0, ${contentCollapsed ? 0 : contentFr}fr)`
  }

  const panelClass = (collapsed: boolean) =>
    `min-w-0 overflow-hidden p-2 flex flex-col ${collapsed && isDesktop ? '!p-0' : ''}`

  const handle = () => (
    <div
      role="separator"
      aria-orientation="vertical"
      title={contentCollapsed ? 'Drag to resize · click to expand content' : 'Drag to resize · click to collapse content'}
      onPointerDown={onHandlePointerDown}
      className="group relative hidden md:flex items-stretch justify-center cursor-col-resize touch-none"
    >
      <div className="w-px bg-surface transition-colors group-hover:bg-accenthover" />
      {contentCollapsed && (
        <span
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest text-dim select-none whitespace-nowrap [writing-mode:vertical-rl] ${contentCollapsed ? 'rotate-180' : ''}`}
        >
          Content
        </span>
      )}
    </div>
  )

  return (
    <div
      ref={gridRef}
      style={gridStyle}
      className="no-drag grid grid-cols-1 md:grid-cols-[minmax(0,3fr)_12px_minmax(0,2fr)] divide-y md:divide-y-0 divide-line flex-1 min-h-0 overflow-x-clip"
    >
      <div className={panelClass(false) + ' min-h-32'}>{props.chat}</div>
      {handle()}
      <div className={panelClass(contentCollapsed) + ' min-h-32'}>{props.content}</div>
    </div>
  )
}
