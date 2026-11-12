import type { ReactNode } from 'react'

type RailMarkerProps = {
  railKey: string
  spanClassName: string
  offsetClassName?: string
  children?: ReactNode
}

export function RailMarker({ railKey, spanClassName, offsetClassName, children }: RailMarkerProps) {
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
