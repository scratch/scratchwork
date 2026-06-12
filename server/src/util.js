/*
 * Small HTTP/content helpers, runtime-agnostic (Web APIs only — no Bun, no node,
 * no Workers-specific calls). Shared by the deploy API and the content server.
 */

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  // Markdown is served as text so the renderer shell can fetch it as plain text
  // rather than the browser trying to interpret it.
  ".md": "text/plain; charset=utf-8",
  ".mdx": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
};

export function contentType(path) {
  const i = path.lastIndexOf(".");
  const ext = i === -1 ? "" : path.slice(i).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Cache policy by file kind. HTML pages get a short TTL so a re-publish shows up
// quickly; static assets cache longer; markdown is short (the shell refetches it).
export function cacheControl(path) {
  const i = path.lastIndexOf(".");
  const ext = i === -1 ? "" : path.slice(i).toLowerCase();
  if (ext === ".html") return "public, max-age=60, s-maxage=300";
  if (ext === ".md" || ext === ".mdx") return "public, max-age=60, s-maxage=300";
  if ([".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".otf"].includes(ext))
    return "public, max-age=3600, s-maxage=86400";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif", ".mp4", ".webm", ".mp3", ".wav"].includes(ext))
    return "public, max-age=86400, s-maxage=604800";
  return "public, max-age=3600";
}

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// A short, unguessable, URL-safe id (base36). Used for both project ids (which
// appear in the URL) and deploy ids. crypto.getRandomValues exists in Bun,
// Workers and Node.
export function generateId(len = 12) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}
