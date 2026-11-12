/** Nothing to show: no document, no focused approval or tool call, nothing pinned. */
export function EmptyPanel({ hasLibrary }: { hasLibrary: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="border border-dashed border-linestrong rounded-lg px-8 py-10 text-center">
        <div className="text-dim text-sm">Agent content renders here</div>
        <div className="text-faint text-xs mt-1 font-mono">
          {hasLibrary ? 'pick an entry from the library above' : 'awaiting output…'}
        </div>
      </div>
    </div>
  )
}
