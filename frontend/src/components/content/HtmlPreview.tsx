/**
 * An HTML document rendered in a fully sandboxed iframe (no scripts, no
 * same-origin). `srcDoc` is built by appending a style that keeps the document
 * scrollable: full-bleed pages routinely set `overflow:hidden` on html/body,
 * and an unscrollable preview is worse than a page that ignores its own rule.
 */
export function HtmlPreview({ html, path }: { html: string; path: string }) {
  return (
    <iframe
      srcDoc={withScrollGuard(html)}
      sandbox=""
      title={path}
      className="flex-1 w-full h-full border-none bg-base"
    />
  )
}

const SCROLL_GUARD = '<style>html,body{margin:0;height:100%;overflow:auto!important}</style>'

/**
 * Inject the scroll guard as late as possible in `<head>` so it wins the cascade
 * (the parser relocates a leading `<style>` into `<head>` anyway), falling back
 * to just before `<body>`, then to the start of the string.
 */
function withScrollGuard(html: string): string {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${SCROLL_GUARD}</head>`)
  if (/<body/i.test(html)) return html.replace(/<body/i, `${SCROLL_GUARD}<body`)
  return `${SCROLL_GUARD}${html}`
}
