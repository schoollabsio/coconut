import { createElement } from 'react'
import type { RailPath } from '../../railGeometry'

export function RailOverlay({ rows, paths }: { rows: readonly unknown[]; paths: RailPath[] }) {
  if (!rows || !paths || !rows.length || !paths.length) return null
  const pathElements = paths.map((path, index) => createElement('path', {
    key: `${path.kind}-${index}-${path.d}`,
    d: path.d,
    fill: 'none',
    stroke: path.kind === 'curve' ? 'var(--color-linestrong)' : 'var(--color-line)',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
  return createElement('svg', {
    'aria-hidden': 'true',
    className: 'pointer-events-none absolute inset-0 h-full w-full',
    preserveAspectRatio: 'none',
  }, pathElements)
}
