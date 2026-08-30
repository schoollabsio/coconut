import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown renderer styled to match the mockup's chat/content look. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-gray-300 leading-relaxed space-y-3 [&_p]:leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="space-y-3">{children}</p>,
          code: ({ children, className }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="bg-gray-800 text-gray-200 rounded px-1.5 py-0.5 text-xs">{children}</code>
            ),
          pre: ({ children }) => (
            <pre className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 text-xs font-mono text-gray-300 overflow-x-auto">
              {children}
            </pre>
          ),
          ul: ({ children }) => <ul className="list-disc list-outside ml-4 space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-outside ml-4 space-y-1.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          h1: ({ children }) => <h1 className="text-lg font-semibold text-gray-100">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold text-gray-100">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-100">{children}</h3>,
          a: ({ children, href }) => (
            <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-gray-700 pl-3 text-gray-400">{children}</blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
