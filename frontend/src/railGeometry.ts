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

/**
 * Build the rail overlay paths from the rendered row topology plus measured
 * bullet boxes. User rows split the rail into independent segments.
 */
export function buildRailPaths(rows: RailRow[], positions: Record<string, RailMeasure>): RailPath[] {
  const lines: RailPath[] = []
  const curves: RailPath[] = []

  let lastMainKey: string | null = null
  let openBranch: { headerKey: string; lastChildKey: string | null } | null = null

  const get = (key: string): RailMeasure | null => positions[key] ?? null

  for (const row of rows) {
    if (row.kind === 'user') {
      lastMainKey = null
      openBranch = null
      continue
    }

    const pos = get(row.key)
    if (!pos) continue

    if (row.kind !== 'group-tool') {
      if (openBranch?.lastChildKey) {
        const childPos = get(openBranch.lastChildKey)
        if (childPos) curves.push(curvePath(childPos, pos))
        openBranch = null
        lastMainKey = row.key
        continue
      }

      if (lastMainKey) {
        const prevPos = get(lastMainKey)
        if (prevPos) lines.push(verticalPath(prevPos, pos))
      }

      lastMainKey = row.key
      openBranch = row.kind === 'group' && row.expanded ? { headerKey: row.key, lastChildKey: null } : null
      continue
    }

    if (!openBranch || row.parentKey !== openBranch.headerKey) continue

    if (!openBranch.lastChildKey) {
      const headerPos = get(openBranch.headerKey)
      if (headerPos) curves.push(curvePath(headerPos, pos))
    } else {
      const prevChildPos = get(openBranch.lastChildKey)
      if (prevChildPos) lines.push(verticalPath(prevChildPos, pos))
    }
    openBranch.lastChildKey = row.key
  }

  return [...lines, ...curves]
}
