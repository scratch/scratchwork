/**
 * Pure route-path matching for published sites. Routing is deterministic: the configured
 * routing mode fixes the segment depth of every route path, so a request path maps to at
 * most one route (its first routeDepth segments) plus a site-file remainder. No storage
 * or service dependencies.
 */
import { isSafeProjectIdentifier } from "./access";
import type { ProjectRoutingMode } from "./config";

/** Path-segment depth of every route path under a routing mode. */
export function routeDepth(mode: ProjectRoutingMode): number {
  return mode === "workspace/project" ? 2 : 3;
}

/** Returns true for a route path of 1+ safe identifier segments, at most 512 chars. */
export function safeRoutePath(routePath: string): boolean {
  return routePath.length > 0 && routePath.length <= 512 && routePath.split("/").every(isSafeProjectIdentifier);
}

/** Maps a request pathname to the only route path it can belong to under the mode: its
 * first routeDepth segments. Returns null when the path is too shallow or a decoded
 * segment is not a safe identifier — segments are decoded individually, so an encoded
 * slash cannot fabricate extra segments. */
export function routePathForRequest(pathname: string, mode: ProjectRoutingMode): string | null {
  const depth = routeDepth(mode);
  const segments = rawPathSegments(pathname);
  if (segments.length < depth) return null;
  const decoded = segments.slice(0, depth).map(decodePathSegment);
  if (!decoded.every(isSafeProjectIdentifier)) return null;
  return decoded.join("/");
}

/** Computes the site path remainder for a matched route path. Compares decoded segments,
 * matching routePathForRequest. Returns null when the route has no remainder (or does not
 * prefix the path), which redirects to the canonical route root. */
export function routeRest(pathname: string, routePath: string): string | null {
  const segments = rawPathSegments(pathname);
  const routeSegments = routePath.split("/");
  if (segments.length < routeSegments.length) return null;
  for (let index = 0; index < routeSegments.length; index += 1) {
    if (decodePathSegment(segments[index]) !== routeSegments[index]) return null;
  }
  const rest = segments.slice(routeSegments.length);
  const trailingSlash = pathname.endsWith("/");
  if (rest.length === 0) return trailingSlash ? "/" : null;
  return `/${rest.join("/")}${trailingSlash ? "/" : ""}`;
}

/** Splits a pathname into its non-empty raw (still URL-encoded) segments. */
function rawPathSegments(pathname: string): ReadonlyArray<string> {
  return pathname.split("/").filter((segment) => segment !== "");
}

/** Percent-decodes one path segment, keeping the raw text when decoding fails. */
function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
