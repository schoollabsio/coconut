import { useEffect, useRef, useState, type ReactNode } from 'react'

const MIN_FR = 0.5
const CLICK_THRESHOLD = 4 // px before a press becomes a drag

/**
 * The 3-column resizable/collapsible grid from the mockup:
 * [tools | handle | chat | handle | content]. Drag handles resize the
 * adjacent panels; clicking a handle collapses its side panel.
 */
export function ColumnGrid(props: { tools: ReactNode; chat: ReactNode; content: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState([1, 2, 2])
  const [collapsed, setCollapsed] = useState([false, false, false])
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches)

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>, left: number, right: number, side: number) => {
    e.preventDefault()
    const handle = e.currentTarget
    const grid = gridRef.current
    if (!grid) return

    const startX = e.clientX
    const startWidths = [...widths]
    const canDrag = !collapsed[left] && !collapsed[right]
    let moved = false

    const handleSpace = 24 // two 12px handles
    const totalFr = widths.reduce((s, w, i) => s + (collapsed[i] ? 0 : w), 0)
    const pxPerFr = (grid.clientWidth - handleSpace) / totalFr

    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('select-none')
    if (canDrag) document.body.classList.add('cursor-col-resize')

    const onMove = (ev: PointerEvent) => {
      if (!canDrag) return
      if (!moved && Math.abs(ev.clientX - startX) < CLICK_THRESHOLD) return
      moved = true
      const deltaFr = (ev.clientX - startX) / pxPerFr
      let d = Math.max(deltaFr, -(startWidths[left] - MIN_FR))
      d = Math.min(d, startWidths[right] - MIN_FR)
      const next = [...startWidths]
      next[left] = startWidths[left] + d
      next[right] = startWidths[right] - d
      setWidths(next)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      document.body.classList.remove('select-none', 'cursor-col-resize')
      if (!moved) {
        setCollapsed((c) => c.map((v, i) => (i === side ? !v : v)))
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp, { once: true })
    handle.addEventListener('pointercancel', onUp, { once: true })
  }

  const gridStyle: React.CSSProperties = {}
  if (isDesktop) {
    const w = widths.map((v, i) => (collapsed[i] ? 0 : v))
    gridStyle.gridTemplateColumns = `${w[0]}fr 12px ${w[1]}fr 12px ${w[2]}fr`
  }

  const panelClass = (i: number) =>
    `min-w-0 overflow-hidden p-2 flex flex-col ${collapsed[i] && isDesktop ? '!p-0' : ''}`

  const handle = (left: number, right: number, side: number, label: string, title: string) => (
    <div
      key={`h${side}`}
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={(e) => onHandlePointerDown(e, left, right, side)}
      className="group relative hidden md:flex items-stretch justify-center cursor-col-resize touch-none"
    >
      <div className="w-px bg-surface transition-colors group-hover:bg-accenthover" />
      {collapsed[side] && (
        <span
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest text-dim select-none whitespace-nowrap [writing-mode:vertical-rl] ${side === 0 ? 'rotate-180' : ''}`}
        >
          {label}
        </span>
      )}
    </div>
  )

  return (
    <div
      ref={gridRef}
      style={gridStyle}
      className="no-drag grid grid-cols-1 md:grid-cols-[1fr_12px_2fr_12px_2fr] divide-y md:divide-y-0 divide-line flex-1 min-h-0"
    >
      <div className={panelClass(0) + ' min-h-32'}>{props.tools}</div>
      {handle(0, 1, 0, 'Tools', 'Drag to resize · click to collapse tools')}
      <div className={panelClass(1)}>{props.chat}</div>
      {handle(1, 2, 2, 'Content', 'Drag to resize · click to collapse content')}
      <div className={panelClass(2) + ' min-h-32'}>{props.content}</div>
    </div>
  )
}
