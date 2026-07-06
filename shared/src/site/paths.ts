/*
 * Site-relative path math. A SitePath is a forward-slash relative path inside
 * a site ("docs/notes.md") — never absolute, never escaping the site root.
 * These helpers are string-only on purpose so they behave identically in the
 * CLI, Lambda, and Cloudflare Workers.
 */

/** A forward-slash path relative to a site root, e.g. "docs/notes.md". */
export type SitePath = string;

/** Joins two site path segments, collapsing slashes at the seam. */
export function joinSitePath(a: string, b: string): SitePath {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/** Returns the parent directory of a site path, or "" at the site root. */
export function dirnameSitePath(path: SitePath): SitePath {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

/** Returns the last segment of a site path. */
export function basenameSitePath(path: SitePath): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Removes a trailing extension (case-insensitive) if present. */
export function stripExtension(path: SitePath, extension: string): SitePath {
  return path.toLowerCase().endsWith(extension) ? path.slice(0, -extension.length) : path;
}

/** Rejects paths that are absolute, traversing (".."), or otherwise unservable. */
export function isSafeSitePath(path: SitePath): boolean {
  if (typeof path !== "string") return false;
  if (!path || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
