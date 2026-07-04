/*
 * Content-type and cache-control policy for served site files, keyed by file
 * extension. Used by every serving surface (CLI dev server and deploy
 * targets) so a file is labeled the same way everywhere.
 */

const CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mdx", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".sh", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

/** Returns the lowercased extension of a path including the dot, or "". */
export function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

/** Maps a path to its Content-Type header value, defaulting to octet-stream. */
export function contentType(path: string): string {
  return CONTENT_TYPES.get(extensionOf(path)) ?? "application/octet-stream";
}

/** Checks whether a path serves as Markdown (.md/.mdx). */
export function isMarkdownPath(path: string): boolean {
  return contentType(path).startsWith("text/markdown");
}

/** Picks a Cache-Control policy from the content type: short for pages, longer for assets. */
export function defaultCacheControl(path: string): string {
  const type = contentType(path);
  if (type.startsWith("text/html") || type.startsWith("text/markdown")) {
    return "public, max-age=60, s-maxage=300";
  }
  if (type.startsWith("font/") || type.startsWith("text/css") || type.startsWith("text/javascript")) {
    return "public, max-age=3600, s-maxage=86400";
  }
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
    return "public, max-age=86400, s-maxage=604800";
  }
  return "public, max-age=3600";
}
