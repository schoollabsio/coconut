import { describe, expect, it } from 'vitest'
import { buildRailPaths, type RailRow } from './railGeometry'

const pos = (x: number, top: number, bottom: number) => ({ x, top, bottom })

describe('buildRailPaths', () => {
  it('draws a straight rail through collapsed groups', () => {
    const rows: RailRow[] = [
      { kind: 'text', key: 'a' },
      { kind: 'group', key: 'g', expanded: false },
      { kind: 'tool', key: 'b' },
    ]
    const paths = buildRailPaths(rows, {
      a: pos(10, 0, 10),
      g: pos(10, 20, 30),
      b: pos(10, 40, 50),
    })

    expect(paths).toEqual([
      { kind: 'line', d: 'M 10 10 L 10 20' },
      { kind: 'line', d: 'M 10 30 L 10 40' },
    ])
  })

  it('routes an expanded group through the child lane and back to the main lane', () => {
    const rows: RailRow[] = [
      { kind: 'text', key: 'a' },
      { kind: 'group', key: 'g', expanded: true },
      { kind: 'group-tool', key: 'c1', parentKey: 'g' },
      { kind: 'group-tool', key: 'c2', parentKey: 'g' },
      { kind: 'tool', key: 'b' },
    ]
    const paths = buildRailPaths(rows, {
      a: pos(10, 0, 10),
      g: pos(10, 20, 30),
      c1: pos(42, 40, 50),
      c2: pos(42, 60, 70),
      b: pos(10, 90, 100),
    })

    expect(paths).toEqual([
      { kind: 'line', d: 'M 10 10 L 10 20' },
      { kind: 'line', d: 'M 42 50 L 42 60' },
      { kind: 'curve', d: 'M 10 30 C 10 38 42 32 42 40' },
      { kind: 'curve', d: 'M 42 70 C 42 80 10 80 10 90' },
    ])
  })

  it('breaks the rail across user rows', () => {
    const rows: RailRow[] = [
      { kind: 'text', key: 'a' },
      { kind: 'group', key: 'g', expanded: true },
      { kind: 'group-tool', key: 'c1', parentKey: 'g' },
      { kind: 'user', key: 'u' },
      { kind: 'tool', key: 'b' },
    ]
    const paths = buildRailPaths(rows, {
      a: pos(10, 0, 10),
      g: pos(10, 20, 30),
      c1: pos(42, 40, 50),
      b: pos(10, 80, 90),
    })

    expect(paths).toEqual([
      { kind: 'line', d: 'M 10 10 L 10 20' },
      { kind: 'curve', d: 'M 10 30 C 10 38 42 32 42 40' },
    ])
  })
})
