/**
 * Pure route-path matching for published sites: splitting request paths into a
 * project route prefix plus a site-file remainder. No storage or service dependencies.
 */
import { isSafeProjectIdentifier } from "./access";

/** Returns true for a route path of 1+ safe identifier segments, at most 512 chars. */
export function safeRoutePath(routePath: string): boolean {
  return routePath.length > 0 && routePath.length <= 512 && routePath.split("/").every(isSafeProjectIdentifier);
}

/** Splits a content path into the longest route prefix and remaining site path. Each decoded
 * segment must itself be a safe identifier, so an encoded slash cannot fabricate a
 * multi-segment route from one raw segment. */
export function candidateRoutePaths(pathname: string): ReadonlyArray<string> {
  const segments = rawPathSegments(pathname);
  const candidates: Array<string> = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    const decoded = segments.slice(0, length).map(decodePathSegment);
    if (!decoded.every(isSafeProjectIdentifier)) continue;
    const candidate = decoded.join("/");
    if (safeRoutePath(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/** Computes the site path remainder for a matched route path. Compares decoded segments,
 * matching candidateRoutePaths. Returns null when the route has no remainder (or does not
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
