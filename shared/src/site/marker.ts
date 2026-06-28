export const MARKDOWN_RENDERER_MARKER =
  "<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->";

export function markMarkdownRenderer(html: string): string {
  return `${MARKDOWN_RENDERER_MARKER}\n${html}`;
}

export function isMarkedMarkdownRenderer(html: string): boolean {
  return html.startsWith(MARKDOWN_RENDERER_MARKER);
}
