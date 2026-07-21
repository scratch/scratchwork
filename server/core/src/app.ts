/**
 * HTTP router for the scratchwork server. One app serves two origins: the app host
 * (auth routes and the JSON API) and the content host (published sites). Every JSON
 * endpoint dispatches through the route-policy registry in api-routes.ts (invariant 4);
 * this file owns the browser-facing auth routes and published-content serving. Public
 * projects are served directly; private ones are gated by a handoff flow — /auth/project
 * on the app host authenticates the viewer and redirects to the content host with a
 * one-time token (HANDOFF_PARAM) that redeemHandoffToken exchanges for a path-scoped
 * cookie.
 */
import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { SiteFiles } from "@scratchwork/shared/site/files";
import { servePath } from "@scratchwork/shared/site/serve";
import { defaultRendererHtml } from "@scratchwork/shared/site/default-renderer.generated.js";
import { FIGURE_SVG } from "@scratchwork/shared/assets/figure-svg.generated";
import { isSafeProjectIdentifier } from "./access.ts";
import { dispatchApiRoute, requireReadableSite } from "./api-routes.ts";
import { Auth, AuthError, type AuthShape, type AuthUser } from "./auth.ts";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { PrimitiveDb } from "./db.ts";
import { projectAccessCookie, projectAccessCookieValues } from "./cookies.ts";
import { acceptsHtmlPage, errorPageResponse, errorResponse } from "./error-pages.ts";
import {
  appBaseUrl,
  contentBaseUrl,
  homepageBaseUrl,
  HttpError,
  requestBaseUrl,
  sameOrigin,
  securityHeaders,
} from "./http.ts";
import { projectForRequest, routeRest } from "./routes.ts";
import { canReadProject, SiteStore, SiteStoreError, type LoadedSite } from "./site-store.ts";
import { StorageError } from "./storage.ts";

const NO_STORE = "no-store, must-revalidate";
/**
 * Reserved query parameter carrying the one-time handoff token minted by the app host after
 * it authenticates a private-content viewer. The content host redeems it into a path-scoped
 * cookie and immediately redirects to the clean URL, so the token never stays in the address
 * bar or becomes part of a shareable link.
 */
const HANDOFF_PARAM = "_scratchwork_handoff";

/** Return type shared by every request handler in this file. */
type AppEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpError | AuthError | SiteStoreError | StorageError,
  ServerConfig | SiteStore | Auth | PrimitiveDb
>;

/** The whole server as one platform-neutral HttpApp; adapters provide the four services. */
export const app: HttpApp.Default<never, ServerConfig | SiteStore | Auth | PrimitiveDb> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(request).pipe(
      Effect.catchTags({
        HttpError: (error) => Effect.succeed(errorResponse(request, error.status, error.message)),
        AuthError: (error) => Effect.succeed(errorResponse(request, error.status, error.message)),
        SiteStoreError: (error) => Effect.succeed(errorResponse(request, error.status, error.message)),
        StorageError: (error) => Effect.succeed(errorResponse(request, 500, error.message)),
      }),
    );
  });

/** Routes one HTTP request: browser auth routes here, JSON endpoints through the
 * policy registry, then homepage/published-site serving. */
function handleRequest(request: HttpServerRequest.HttpServerRequest): AppEffect {
  return Effect.gen(function* () {
    const url = new URL(request.url, "http://scratchwork.local");
    const config = yield* ServerConfig;

    if (url.pathname.startsWith("/auth/")) {
      const redirect = canonicalAppRedirect(request, url, config);
      if (redirect != null) return redirect;
    }

    if (url.pathname === "/auth/login") {
      const auth = yield* Auth;
      return yield* auth.login(request, url, appBaseUrl(request, config));
    }

    if (url.pathname === "/auth/callback/google" || url.pathname === "/auth/google/callback") {
      const auth = yield* Auth;
      return yield* auth.callback(request, url, appBaseUrl(request, config));
    }

    if (url.pathname === "/auth/logout") {
      const auth = yield* Auth;
      return auth.logout(appBaseUrl(request, config));
    }

    if (url.pathname === "/auth/project") {
      return yield* issueProjectAccess(request, url);
    }

    const apiResponse = yield* dispatchApiRoute(request, url);
    if (apiResponse != null) return apiResponse;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    const homepageOrigin = requestHomepageOrigin(request, config);
    if (homepageOrigin != null) {
      return yield* serveHomepage(request, url, homepageOrigin);
    }
    return yield* servePublishedSite(request, url);
  });
}

// ---------------------------------------------------------------------------
// Published-site serving and the private-content handoff
// ---------------------------------------------------------------------------

/** Authenticates on the app host and sends a one-time handoff token to the content host. */
function issueProjectAccess(request: HttpServerRequest.HttpServerRequest, url: URL): AppEffect {
  return Effect.gen(function* () {
    const project = url.searchParams.get("route");
    if (project == null) return yield* Effect.fail(new HttpError({ status: 400, message: "Missing route" }));
    // Reject malformed names here so they never become backend keys (an empty or ".."
    // value would otherwise 500 in the DB key guard).
    if (!isSafeProjectIdentifier(project)) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid route" }));
    }
    const config = yield* ServerConfig;
    const contentBase = contentBaseUrl(request, config);
    const returnTo = safeContentReturnTo(url.searchParams.get("returnTo"), contentBase, project)
      ?? safeHomepageReturnTo(url.searchParams.get("returnTo"), project, config)
      ?? `${contentBase}/${project}/`;
    const auth = yield* Auth;
    const user = yield* auth.currentUser(request);
    if (user == null) {
      const loginUrl = new URL("/auth/login", appBaseUrl(request, config));
      loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
      return HttpServerResponse.redirect(loginUrl, { status: 302 });
    }

    const siteStore = yield* SiteStore;
    const loaded = yield* siteStore.loadProject(project);
    if (acceptsHtmlPage(request) && (loaded == null || !canReadProject(loaded.record, user, config))) {
      return projectUnavailableResponse(project, user, `${url.pathname}${url.search}`);
    }
    const site = yield* requireReadableSite(loaded, user, config);

    const token = yield* auth.issueProjectAccessToken(site.record.project, user, "handoff");
    const target = new URL(returnTo);
    target.searchParams.set(HANDOFF_PARAM, token);
    return HttpServerResponse.redirect(target.toString(), { status: 302 });
  });
}

/** The browser-facing dead end of the handoff flow: the project is missing or this account
 * can't read it. Missing and forbidden render the same page with the same status so the
 * page never confirms which projects exist, and the signed-in viewer gets a way to retry
 * as someone else — /auth/login always asks Google for the account chooser, and finishing
 * it replaces the session cookie and re-runs this same /auth/project URL. */
function projectUnavailableResponse(
  project: string,
  user: AuthUser,
  retryPath: string,
): HttpServerResponse.HttpServerResponse {
  return errorPageResponse({
    status: 404,
    title: "Project not available",
    message: `"${project}" doesn't exist, or the account you're signed in with doesn't have access to it.`,
    note: `You're signed in as ${user.email}.`,
    actions: [
      {
        label: "Sign in with a different account",
        href: `/auth/login?returnTo=${encodeURIComponent(retryPath)}`,
        primary: true,
      },
    ],
  });
}

/** Serves public content at its clean URL, or gates private content behind the cookie flow. */
function servePublishedSite(request: HttpServerRequest.HttpServerRequest, url: URL): AppEffect {
  return Effect.gen(function* () {
    const site = yield* loadSiteForPath(url.pathname);
    if (site == null) {
      if (url.pathname !== "/") {
        return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
      }
      return HttpServerResponse.text("scratchwork server\n", {
        contentType: "text/plain; charset=utf-8",
        headers: securityHeaders(),
      });
    }
    const config = yield* ServerConfig;
    if (canReadProject(site.record, null, config)) {
      return yield* serveProjectContent(site, url, true);
    }
    return yield* servePrivateContent(request, url, site, config);
  });
}

/** Serves gated content: redeems a handoff token into a path-scoped cookie, honors an
 * existing cookie, or sends the viewer through the app-host authentication handoff. */
function servePrivateContent(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: ServerConfigShape,
): AppEffect {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const project = site.record.project;

    const handoffToken = url.searchParams.get(HANDOFF_PARAM);
    if (handoffToken != null) {
      return yield* redeemHandoffToken(request, url, site, config, auth, handoffToken);
    }

    const cookieUser = yield* projectAccessUser(request, auth, site, config);
    if (cookieUser != null) {
      // Everything on the content host is same-origin, so another project's JS could
      // fetch/iframe this project with the viewer's cookie attached. Subresource requests
      // must therefore prove (via Referer, unforgeable from scripts) that the requesting
      // page lives inside this project. Top-level navigations stay unrestricted.
      if (blockedCrossProjectSubresource(request, project)) {
        return yield* Effect.fail(new HttpError({ status: 403, message: "Cross-project request rejected" }));
      }
      return yield* serveProjectContent(site, url, false);
    }

    if (isSubresourceRequest(request)) {
      // A fetch/img/script can't complete the OAuth redirect dance; fail fast instead of
      // bouncing it through the app host.
      return yield* Effect.fail(new HttpError({ status: 401, message: "Authentication required" }));
    }
    return projectAccessRedirect(request, url, site, config);
  });
}

/** Exchanges a valid handoff token for a path-scoped content cookie and redirects to the
 * clean canonical URL; an invalid token redirects clean so the handoff re-runs. */
function redeemHandoffToken(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: ServerConfigShape,
  auth: AuthShape,
  token: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError> {
  return Effect.gen(function* () {
    const project = site.record.project;
    // Rebuild the redirect target from the canonical project name so the cookie's Path
    // attribute always matches it, even when the request path was percent-encoded.
    const cleanTarget = canonicalContentPath(url, project);
    const user = yield* auth
      .verifyProjectAccessToken(token, project, "handoff")
      .pipe(Effect.orElseSucceed(() => null));
    if (user == null || !canReadProject(site.record, user, config)) {
      return HttpServerResponse.redirect(cleanTarget, { status: 302 });
    }
    const cookieToken = yield* auth.issueProjectAccessToken(project, user, "cookie");
    return HttpServerResponse.redirect(cleanTarget, {
      status: 302,
      headers: {
        "set-cookie": projectAccessCookie(cookieToken, project, contentBaseUrl(request, config), config.auth.sessionTtlSeconds),
      },
    });
  });
}

/** Verifies the request's project-access cookies and current read access, if any. */
function projectAccessUser(
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

/** Serves the resolved project's file for the request path, or 308-redirects to the
 * trailing-slash canonical root when the path has no remainder under the route. */
function serveProjectContent(
  site: LoadedSite,
  url: URL,
  isPublic: boolean,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError, ServerConfig> {
  const rest = routeRest(url.pathname, site.record.project);
  if (rest == null) {
    return Effect.succeed(HttpServerResponse.redirect(`/${site.record.project}/${url.search}`, { status: 308 }));
  }
  return serveSiteFiles(site, rest, url.search, `/${site.record.project}`, isPublic);
}

/** Serves one file from a loaded site under the given canonical path prefix. */
function serveSiteFiles(
  site: LoadedSite,
  rest: string,
  search: string,
  pathPrefix: string,
  isPublic: boolean,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError, ServerConfig> {
  return servePath(rest, search, {
    cacheControl: () => NO_STORE,
    defaultFaviconSvg: FIGURE_SVG,
    headers: () => publishedSiteHeaders(isPublic),
    pathPrefix,
    rendererFallback: Effect.succeed(defaultRendererHtml),
  }).pipe(
    Effect.catchTag("SiteFileError", (error) =>
      Effect.fail(new HttpError({ status: 500, message: error.message })),
    ),
    Effect.provideService(SiteFiles, site.siteFiles),
  );
}

/** Loads the published site owning the request path. Routing is deterministic: the
 * path's first segment is the only project it can belong to, so resolution is a single
 * pointer lookup. */
function loadSiteForPath(
  pathname: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError, SiteStore> {
  return Effect.gen(function* () {
    const project = projectForRequest(pathname);
    if (project == null) return null;
    const siteStore = yield* SiteStore;
    return yield* siteStore.loadProject(project);
  });
}

/** Rebuilds the request's clean canonical URL (path + query) on the project's route
 * prefix, dropping the handoff parameter. */
function canonicalContentPath(url: URL, project: string): string {
  const rest = routeRest(url.pathname, project) ?? "/";
  const params = new URLSearchParams(url.search);
  params.delete(HANDOFF_PARAM);
  const search = params.toString();
  return `/${project}${rest}${search === "" ? "" : `?${search}`}`;
}

/** Detects browser subresource loads (fetch/img/script/frame/...) via Sec-Fetch-Dest.
 * Requests without the header (non-browsers, old browsers) count as navigations. */
function isSubresourceRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  const dest = request.headers["sec-fetch-dest"]?.toLowerCase();
  return dest != null && dest !== "document";
}

/** Returns true for a private-content subresource request whose initiating page is outside
 * this project. The Referer is script-unforgeable, and content responses set
 * `Referrer-Policy: same-origin`, so in-project pages always send a usable full path while
 * another project's page sends its own path (or nothing, if it strips the referrer) and is
 * refused. Top-level navigations are never blocked. */
function blockedCrossProjectSubresource(
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

/** Redirects an unauthenticated private-content viewer to the app host's handoff route. */
function projectAccessRedirect(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: { readonly appUrl?: string; readonly contentUrl?: string },
): HttpServerResponse.HttpServerResponse {
  const redirect = new URL("/auth/project", appBaseUrl(request, config));
  redirect.searchParams.set("route", site.record.project);
  redirect.searchParams.set("returnTo", contentRequestUrl(url, contentBaseUrl(request, config)));
  return HttpServerResponse.redirect(redirect, { status: 302 });
}

/** Accepts a returnTo only when it is a clean same-origin URL inside the project route. */
function safeContentReturnTo(value: string | null, contentBase: string, project: string): string | null {
  if (value == null || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const base = new URL(contentBase);
    if (url.origin !== base.origin) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== `/${project}` && !url.pathname.startsWith(`/${project}/`)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Accepts a returnTo on the canonical home origin, where the homepage project owns the
 * whole path space, when the handoff is for the homepage project. */
function safeHomepageReturnTo(value: string | null, project: string, config: ServerConfigShape): string | null {
  const canonical = homepageBaseUrl(project, config);
  if (canonical == null || value == null || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(canonical).origin) return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Rebuilds the requested path and query as an absolute URL on the content origin. */
function contentRequestUrl(url: URL, contentBase: string): string {
  return new URL(`${url.pathname}${url.search}`, contentBase).toString();
}

/** Adds static-asset headers for published content. Content responses send full same-origin
 * referrers (and nothing cross-origin) so the private-content subresource guard can verify
 * which page issued a request. Only public content is CORS-readable. */
function publishedSiteHeaders(isPublic: boolean): Record<string, string> {
  const headers = securityHeaders();
  headers["Referrer-Policy"] = "same-origin";
  if (isPublic) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

// ---------------------------------------------------------------------------
// The server homepage: one ordinary project served across a home origin's whole
// path space (spec "Server homepage"). Reserved prefixes (/auth/*, /api/*, /health)
// are handled before dispatch reaches here, so they keep their server-level behavior
// on every host and the matching homepage files are unreachable.
// ---------------------------------------------------------------------------

/** Matches the request's origin against the configured homepage origins; null when the
 * server has no homepage or the request is for another host. */
function requestHomepageOrigin(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): string | null {
  if (config.homepageProject == null || config.homepageUrls.length === 0) return null;
  const requestBase = requestBaseUrl(request);
  if (requestBase == null) return null;
  return config.homepageUrls.find((url) => sameOrigin(url, requestBase)) ?? null;
}

/** Serves the homepage project on a home origin. Non-canonical home origins 308 to the
 * canonical one; an unpublished homepage answers with setup instructions instead. */
function serveHomepage(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  origin: string,
): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const canonical = config.homepageUrls[0];
    if (origin !== canonical) {
      return HttpServerResponse.redirect(new URL(`${url.pathname}${url.search}`, canonical).toString(), { status: 308 });
    }
    const project = config.homepageProject;
    if (project == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    const siteStore = yield* SiteStore;
    const site = yield* siteStore.loadProject(project);
    if (site == null) {
      return homepageSetupResponse(request, project, appBaseUrl(request, config));
    }
    if (canReadProject(site.record, null, config)) {
      return yield* serveSiteFiles(site, url.pathname, url.search, "", true);
    }
    return yield* servePrivateHomepage(request, url, site, config, canonical);
  });
}

/** Gates a non-public homepage: redeems a handoff token into a "/"-scoped cookie, honors
 * an existing cookie, or sends the viewer through the app-host authentication handoff.
 * Mirrors servePrivateContent, adjusted for a project that owns its whole origin. */
function servePrivateHomepage(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: ServerConfigShape,
  canonical: string,
): AppEffect {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const project = site.record.project;

    const handoffToken = url.searchParams.get(HANDOFF_PARAM);
    if (handoffToken != null) {
      const cleanTarget = pathWithoutHandoff(url);
      const user = yield* auth
        .verifyProjectAccessToken(handoffToken, project, "handoff")
        .pipe(Effect.orElseSucceed(() => null));
      if (user == null || !canReadProject(site.record, user, config)) {
        return HttpServerResponse.redirect(cleanTarget, { status: 302 });
      }
      const cookieToken = yield* auth.issueProjectAccessToken(project, user, "cookie");
      return HttpServerResponse.redirect(cleanTarget, {
        status: 302,
        headers: {
          "set-cookie": projectAccessCookie(cookieToken, project, canonical, config.auth.sessionTtlSeconds, "/"),
        },
      });
    }

    const cookieUser = yield* projectAccessUser(request, auth, site, config);
    if (cookieUser != null) {
      // The content host is same-site with a typical home origin, so a project's JS
      // there could fetch/iframe the private homepage with the viewer's cookie attached.
      // As on the content host, subresource requests must prove (via Referer) that the
      // requesting page lives on the home origin; top-level navigations stay unrestricted.
      if (isSubresourceRequest(request) && !refererMatchesOrigin(request, canonical)) {
        return yield* Effect.fail(new HttpError({ status: 403, message: "Cross-site request rejected" }));
      }
      return yield* serveSiteFiles(site, url.pathname, url.search, "", false);
    }

    if (isSubresourceRequest(request)) {
      return yield* Effect.fail(new HttpError({ status: 401, message: "Authentication required" }));
    }
    const redirect = new URL("/auth/project", appBaseUrl(request, config));
    redirect.searchParams.set("route", project);
    redirect.searchParams.set("returnTo", new URL(`${url.pathname}${url.search}`, canonical).toString());
    return HttpServerResponse.redirect(redirect, { status: 302 });
  });
}

/** Setup instructions served on a home domain until the homepage project is published.
 * A freshly deployed server tells its own deployer how to finish setting it up. */
function homepageSetupResponse(
  request: HttpServerRequest.HttpServerRequest,
  project: string,
  appBase: string,
): HttpServerResponse.HttpServerResponse {
  const command = `scratchwork publish --server ${appBase} --project ${project} --public`;
  if (!acceptsHtmlPage(request)) {
    return HttpServerResponse.text(
      `This server's homepage is the project "${project}", which has not been published yet.\nPublish it with:\n\n  ${command}\n`,
      { status: 404, contentType: "text/plain; charset=utf-8", headers: securityHeaders() },
    );
  }
  return errorPageResponse({
    status: 404,
    title: "This homepage hasn't been published yet",
    message: `This domain serves the project "${project}", which doesn't exist on this server yet.`,
    note: `Publish it with: ${command}`,
  });
}

/** The request's path and query with the handoff parameter removed. */
function pathWithoutHandoff(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete(HANDOFF_PARAM);
  const search = params.toString();
  return `${url.pathname}${search === "" ? "" : `?${search}`}`;
}

/** Returns true when the request's Referer page lives on the given origin. */
function refererMatchesOrigin(request: HttpServerRequest.HttpServerRequest, origin: string): boolean {
  const referer = request.headers.referer;
  if (referer == null) return false;
  return sameOrigin(referer, origin);
}

/** Sends auth routes to the configured app origin before setting host-bound cookies. */
function canonicalAppRedirect(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  config: { readonly appUrl?: string },
): HttpServerResponse.HttpServerResponse | null {
  const appBase = appBaseUrl(request, config);
  const requestBase = requestBaseUrl(request);
  if (requestBase == null || sameOrigin(requestBase, appBase)) return null;
  const target = new URL(`${url.pathname}${url.search}`, appBase);
  // Preserve the method and body for the CLI's token-exchange POST. Browser auth
  // routes remain ordinary GET redirects.
  return HttpServerResponse.redirect(target.toString(), {
    status: request.method === "GET" || request.method === "HEAD" ? 302 : 307,
  });
}
