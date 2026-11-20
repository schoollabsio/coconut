import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown renderer styled to match the mockup's chat/content look.
 *  Tables are styled explicitly: Tailwind preflight zeroes border-width and
 *  padding on every element, so cell rules and cell padding must be set here
 *  (and a bare `border` utility would paint in currentColor — always pair it
 *  with a color). One token for every cell edge, because preflight forces
 *  border-collapse and mixed colors on adjacent edges collapse unpredictably. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`text-base text-mute leading-loose space-y-4 [&_p]:leading-loose ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="space-y-3">{children}</p>,
          code: ({ children, className }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="bg-surface2 text-ink rounded px-1.5 py-0.5 text-xs">{children}</code>
            ),
          pre: ({ children }) => (
            <pre className="bg-base border border-line rounded-lg px-3 py-2.5 text-xs font-mono text-mute overflow-x-auto">
              {children}
            </pre>
          ),
          ul: ({ children }) => <ul className="list-disc list-outside ml-4 space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-outside ml-4 space-y-1.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          h1: ({ children }) => <h1 className="text-3xl font-semibold text-ink">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-semibold text-brownbright">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-semibold text-ink">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-medium text-ink">{children}</h4>,
          a: ({ children, href }) => (
            <a href={href} className="text-info hover:underline" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-linestrong">
              <table className="w-full text-xs leading-5">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-surface2 text-ink">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-linestrong px-2 py-1 text-left font-medium align-top">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-linestrong px-2 py-1 align-top">{children}</td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-linestrong pl-3 text-mute italic">{children}</blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
