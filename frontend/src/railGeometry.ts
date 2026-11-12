export interface RailMeasure {
  x: number
  top: number
  bottom: number
}

export type RailRow =
  | { kind: 'user'; key: string }
  | { kind: 'thinking'; key: string }
  | { kind: 'text'; key: string }
  | { kind: 'tool'; key: string }
  | { kind: 'group'; key: string; expanded?: boolean }
  | { kind: 'group-tool'; key: string; parentKey: string }

export type RailPath = { kind: 'line' | 'curve'; d: string }

function verticalPath(from: RailMeasure, to: RailMeasure): RailPath {
  return {
    kind: 'line',
    d: `M ${from.x} ${from.bottom} L ${to.x} ${to.top}`,
  }
}

function curvePath(from: RailMeasure, to: RailMeasure): RailPath {
  const startY = from.bottom
  const endY = to.top
  const distance = Math.max(0, endY - startY)
  const bend = Math.min(15, Math.max(8, Math.floor(distance / 2)))
  return {
    kind: 'curve',
    d: `M ${from.x} ${startY} C ${from.x} ${startY + bend} ${to.x} ${endY - bend} ${to.x} ${endY}`,
  }
}

/** A row on the main line: anything that is neither a user prompt nor a group child. */
type MainRow = Exclude<RailRow, { kind: 'user' } | { kind: 'group-tool' }>
type ChildRow = Extract<RailRow, { kind: 'group-tool' }>

/** An expanded group whose children are still being walked. */
type Branch = { headerKey: string; lastChildKey: string | null }

/**
 * The walk's running state. `lastMainKey` is the previous main-line bullet
 * (the only one a vertical may start from) and `openBranch` the group whose
 * children may still follow — both reset at a user row.
 */
type Walk = {
  lines: RailPath[]
  curves: RailPath[]
  lastMainKey: string | null
  openBranch: Branch | null
  get: (key: string) => RailMeasure | null
}

/**
 * Build the rail overlay paths from the rendered row topology plus measured
 * bullet boxes. User rows split the rail into independent segments.
 */
export function buildRailPaths(rows: RailRow[], positions: Record<string, RailMeasure>): RailPath[] {
  const walk: Walk = {
    lines: [],
    curves: [],
    lastMainKey: null,
    openBranch: null,
    get: (key) => positions[key] ?? null,
  }
  for (const row of rows) {
    // A user row starts a fresh segment: nothing above it may connect across.
    if (row.kind === 'user') {
      walk.lastMainKey = null
      walk.openBranch = null
      continue
    }
    // Unmeasured rows (off-screen, not yet rendered) are skipped, not connected.
    const pos = walk.get(row.key)
    if (!pos) continue
    if (row.kind === 'group-tool') connectChild(walk, row, pos)
    else connectMain(walk, row, pos)
  }
  // Curves after lines: they cross the lanes, so they paint on top.
  return [...walk.lines, ...walk.curves]
}

/** Connect a main-line row, first closing an open group branch if one is open. */
function connectMain(walk: Walk, row: MainRow, pos: RailMeasure): void {
  if (walk.openBranch?.lastChildKey) {
    // The group's children hang in the child lane, so the spine does not resume
    // from the header — it curves back from the last child that was drawn.
    const childPos = walk.get(walk.openBranch.lastChildKey)
    if (childPos) walk.curves.push(curvePath(childPos, pos))
    walk.openBranch = null
    walk.lastMainKey = row.key
    return
  }
  if (walk.lastMainKey) {
    const prevPos = walk.get(walk.lastMainKey)
    if (prevPos) walk.lines.push(verticalPath(prevPos, pos))
  }
  walk.lastMainKey = row.key
  walk.openBranch = row.kind === 'group' && row.expanded ? { headerKey: row.key, lastChildKey: null } : null
}

/** Connect a group child: curve out from the header, then straight down the children. */
function connectChild(walk: Walk, row: ChildRow, pos: RailMeasure): void {
  const branch = walk.openBranch
  // A child of a collapsed group (or of one the walk already left) gets no rail.
  if (!branch || row.parentKey !== branch.headerKey) return
  const from = branch.lastChildKey ? walk.get(branch.lastChildKey) : walk.get(branch.headerKey)
  if (from) {
    if (branch.lastChildKey) walk.lines.push(verticalPath(from, pos))
    else walk.curves.push(curvePath(from, pos))
  }
  // The lane advances either way: if the bullet above never measured, the next
  // child must continue from this one rather than retry it forever.
  walk.openBranch = { ...branch, lastChildKey: row.key }
}
