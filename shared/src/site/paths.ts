export type SitePath = string;

export function joinSitePath(a: string, b: string): SitePath {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

export function dirnameSitePath(path: SitePath): SitePath {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function basenameSitePath(path: SitePath): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function stripExtension(path: SitePath, extension: string): SitePath {
  return path.toLowerCase().endsWith(extension) ? path.slice(0, -extension.length) : path;
}

export function isSafeSitePath(path: SitePath): boolean {
  if (typeof path !== "string") return false;
  if (!path || path.length > 1024) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function cleanPathname(pathname: string): string {
  const clean = pathname.replace(/\/{2,}/g, "/");
  return clean.startsWith("/") ? clean : `/${clean}`;
}
