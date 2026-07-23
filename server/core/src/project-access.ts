/**
 * Resolves the viewer identity carried by a private project's path-scoped
 * access cookie. Shared by published-content serving (app.ts) and the
 * content-origin comments API (comments-routes.ts), so both gates verify the
 * cookie and re-check read access identically.
 */
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Effect from "effect/Effect";
import type { AuthShape, AuthUser } from "./auth.ts";
import type { ServerConfigShape } from "./config.ts";
import { projectAccessCookieValues } from "./cookies.ts";
import { routeRest } from "./routes.ts";
import { canReadProject, type LoadedSite } from "./site-store.ts";

/** Verifies the request's project-access cookies and current read access, if any. */
export function projectAccessUser(
  request: HttpServerRequest.HttpServerRequest,
  auth: AuthShape,
  site: LoadedSite,
  config: ServerConfigShape,
): Effect.Effect<AuthUser | null> {
  return Effect.gen(function* () {
    for (const value of projectAccessCookieValues(request, site.record.project)) {
      const user = yield* auth
        .verifyProjectAccessToken(value, site.record.project, "cookie")
        .pipe(Effect.orElseSucceed(() => null));
      // Re-check read access on every request so revocation applies immediately even
      // though the cookie itself is long-lived.
      if (user != null && canReadProject(site.record, user, config)) return user;
    }
    return null;
  });
}

/** Detects browser subresource loads (fetch/img/script/frame/...) via Sec-Fetch-Dest.
 * Requests without the header (non-browsers, old browsers) count as navigations. */
export function isSubresourceRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  const dest = request.headers["sec-fetch-dest"]?.toLowerCase();
  return dest != null && dest !== "document";
}

/** Returns true for a private-content subresource request whose initiating page is outside
 * this project. The Referer is script-unforgeable, and content responses set
 * `Referrer-Policy: same-origin`, so in-project pages always send a usable full path while
 * another project's page sends its own path (or nothing, if it strips the referrer) and is
 * refused. Top-level navigations are never blocked. */
export function blockedCrossProjectSubresource(
  request: HttpServerRequest.HttpServerRequest,
  project: string,
): boolean {
  if (!isSubresourceRequest(request)) return false;
  const referer = request.headers.referer;
  if (referer == null) return true;
  try {
    return routeRest(new URL(referer).pathname, project) == null;
  } catch {
    return true;
  }
}
