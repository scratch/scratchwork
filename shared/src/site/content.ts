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

export function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

export function contentType(path: string): string {
  return CONTENT_TYPES.get(extensionOf(path)) ?? "application/octet-stream";
}

export function defaultCacheControl(path: string): string {
  const ext = extensionOf(path);
  if (ext === ".html" || ext === ".md" || ext === ".mdx") {
    return "public, max-age=60, s-maxage=300";
  }
  if ([".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".otf"].includes(ext)) {
    return "public, max-age=3600, s-maxage=86400";
  }
  if (
    [".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif", ".mp4", ".webm", ".mp3", ".wav"].includes(ext)
  ) {
    return "public, max-age=86400, s-maxage=604800";
  }
  return "public, max-age=3600";
}
