/**
 * Pure route matching for published sites. Every published project lives at one top-level
 * path segment — its globally unique name — so a request path maps to at most one project
 * plus a site-file remainder. No storage or service dependencies.
 */
import { isSafeProjectIdentifier } from "./access.ts";

/** Maps a request pathname to the only project it can belong to: its decoded first
 * segment. Returns null when the path has no segments or the decoded segment is not a
 * safe project identifier — the segment is decoded on its own, so an encoded slash
 * cannot fabricate extra segments, and an undecodable segment stays raw and fails on
 * its "%". */
export function projectForRequest(pathname: string): string | null {
  const segment = rawPathSegments(pathname)[0];
  if (segment == null) return null;
  const decoded = decodePathSegment(segment);
  return isSafeProjectIdentifier(decoded) ? decoded : null;
}

/** Computes the site path remainder beneath a project's route prefix. Compares the
 * decoded first segment, matching projectForRequest. Returns null when the path has no
 * remainder (or does not sit under the project), which redirects to the canonical
 * project root. */
export function routeRest(pathname: string, project: string): string | null {
  const segments = rawPathSegments(pathname);
  if (segments.length === 0 || decodePathSegment(segments[0]) !== project) return null;
  const rest = segments.slice(1);
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
