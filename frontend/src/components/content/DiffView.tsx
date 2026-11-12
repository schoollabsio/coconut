/** Line-wise diff rendering, matching the mockup's DIFF_CLASSES. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <div className="rounded-lg border border-line bg-base py-2 font-mono text-xs leading-5 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} className={`px-3 whitespace-pre ${diffLineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

/**
 * Render by prefix, the same convention buildUnifiedDiff emits: `---`/`+++`
 * headers, `@@` hunk markers and `…` elisions, then + / - / context.
 */
function diffLineClass(line: string): string {
  if (line.startsWith('---') || line.startsWith('+++')) return 'text-faint'
  if (line.startsWith('@@') || line === '…') return 'text-info/80 bg-accentsoft'
  if (line.startsWith('+')) return 'bg-ok/10 text-ok'
  if (line.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-mute'
}
