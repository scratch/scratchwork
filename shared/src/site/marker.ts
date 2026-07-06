/*
 * The marker comment that distinguishes a Markdown-renderer index.html from
 * ordinary static HTML. The CLI stamps it onto renderer shells at build and
 * publish time; the routing layer checks for it when deciding whether an
 * index.html serves a page or renders Markdown routes.
 */

/** Comment prepended to renderer shells so routing can recognize them. */
export const MARKDOWN_RENDERER_MARKER =
  "<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->";

/** Prepends the renderer marker to an HTML document. */
export function markMarkdownRenderer(html: string): string {
  return `${MARKDOWN_RENDERER_MARKER}\n${html}`;
}

/** Checks whether an HTML document starts with the renderer marker. */
export function isMarkedMarkdownRenderer(html: string): boolean {
  return html.startsWith(MARKDOWN_RENDERER_MARKER);
}
