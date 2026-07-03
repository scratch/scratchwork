/**
 * HTTP router for the scratchwork server. One app serves two origins: the app host
 * (auth routes and /api/*) and the content host (published sites). Public projects are
 * served directly; private ones are gated by a handoff flow — /auth/project on the
 * app host authenticates the viewer and redirects to the content host with a one-time
 * token (HANDOFF_PARAM) that redeemHandoffToken exchanges for a path-scoped cookie.
 */
import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { SiteFiles } from "../../../shared/src/site/files";
import { servePath } from "../../../shared/src/site/serve";
import { defaultRendererHtml } from "../../../shared/src/site/default-renderer.generated.js";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { Auth, AuthError, type AuthShape, type AuthUser } from "./auth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { projectAccessCookie, projectAccessCookieValues } from "./cookies";
import { errorJson, HttpError, jsonResponse, securityHeaders } from "./http";
import { readPublishRequest } from "./publish-request";
import { candidateRoutePaths, routeRest } from "./routes";
import { projectKey, type SiteRecord } from "./site-records";
import { canReadProject, SiteStore, SiteStoreError, type LoadedSite } from "./site-store";
import { StorageError } from "./storage";

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
  ServerConfig | SiteStore | Auth
>;

/** The whole server as one platform-neutral HttpApp; adapters provide the three services. */
export const app: HttpApp.Default<never, ServerConfig | SiteStore | Auth> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(request).pipe(
      Effect.catchTags({
        HttpError: (error) => Effect.succeed(errorJson(error.status, error.message)),
        AuthError: (error) => Effect.succeed(errorJson(error.status, error.message)),
        SiteStoreError: (error) => Effect.succeed(errorJson(error.status, error.message)),
        StorageError: (error) => Effect.succeed(errorJson(500, error.message)),
      }),
    );
  });

/** Routes one HTTP request to auth, API, health, or published-site handling. */
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

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true }, 200);
    }

    if (url.pathname === "/api/me") {
      const auth = yield* Auth;
      const user = yield* auth.currentUser(request);
      return jsonResponse({ authenticated: user != null, user }, 200);
    }

    if (url.pathname === "/api/publish") {
      if (request.method !== "POST") {
        return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
      }
      return yield* publish(request);
    }

    if (url.pathname === "/api/projects" && request.method === "GET") {
      return yield* listProjects(request);
    }

    if (url.pathname === "/api/resolve" && request.method === "GET") {
      return yield* resolveProjectPath(request, url);
    }

    const projectApi = projectApiPath(url.pathname);
    if (projectApi != null) {
      if (request.method === "GET" && projectApi.action == null) return yield* projectInfo(request, projectApi.workspace, projectApi.project);
      if (request.method === "GET" && projectApi.action === "bundle") return yield* projectBundle(request, projectApi.workspace, projectApi.project);
      if (request.method === "POST" && projectApi.action === "unpublish") return yield* unpublishProject(request, projectApi.workspace, projectApi.project);
      if (request.method === "DELETE" && projectApi.action == null) return yield* deleteProject(request, projectApi.workspace, projectApi.project);
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    return yield* servePublishedSite(request, url);
  });
}

/** Parses /api/projects/:workspace/:project(/:action) paths; null when it is not one. */
function projectApiPath(pathname: string): { readonly workspace: string; readonly project: string; readonly action?: "unpublish" | "bundle" } | null {
  const match = /^\/api\/projects\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (match == null) return null;
  const action = match[3];
  if (action != null && action !== "unpublish" && action !== "bundle") return null;
  try {
    return {
      workspace: decodeURIComponent(match[1]),
      project: decodeURIComponent(match[2]),
      action: action as "unpublish" | "bundle" | undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

/** Handles `POST /api/publish` through bearer auth and SiteStore. */
function publish(request: HttpServerRequest.HttpServerRequest): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const publishRequest = yield* readPublishRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.publish(publishRequest, user, config);
    const url = publishedUrl(contentBaseUrl(request, config), result.routePath, result.openPath);
    return jsonResponse({ ...result, url }, 200);
  });
}

/** Lists projects visible in the authenticated user's owner index. */
function listProjects(request: HttpServerRequest.HttpServerRequest): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const projects = yield* siteStore.listProjects(user);
    return jsonResponse({ projects: projects.map((project) => projectSummary(project)) }, 200);
  });
}

/** Resolves a published content path (under any route strategy) to its project. */
function resolveProjectPath(request: HttpServerRequest.HttpServerRequest, url: URL): AppEffect {
  return Effect.gen(function* () {
    const path = url.searchParams.get("path");
    if (path == null || !path.startsWith("/")) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Missing path" }));
    }
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const site = yield* requireReadableSite(yield* loadSiteForPath(path), user, config);
    return jsonResponse({ project: projectSummary(site.record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Returns metadata for one project. */
function projectInfo(request: HttpServerRequest.HttpServerRequest, workspace: string, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const site = yield* requireReadableSite(yield* siteStore.loadProject(workspace, project), user, config);
    return jsonResponse({ project: projectSummary(site.record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Returns the current project bundle for clone/read workflows. */
function projectBundle(request: HttpServerRequest.HttpServerRequest, workspace: string, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    yield* requireReadableSite(yield* siteStore.loadProject(workspace, project), user, config);
    const bundle = yield* siteStore.bundle(workspace, project);
    if (bundle == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    return jsonResponse({ bundle }, 200);
  });
}

/** Makes a project owner-only by setting visibility to private. */
function unpublishProject(request: HttpServerRequest.HttpServerRequest, workspace: string, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const record = yield* siteStore.unpublish(workspace, project, user);
    return jsonResponse({ project: projectSummary(record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Deletes a project pointer and route index. */
function deleteProject(request: HttpServerRequest.HttpServerRequest, workspace: string, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    yield* siteStore.deleteProject(workspace, project, user);
    return jsonResponse({ ok: true }, 200);
  });
}

/** Gates a loaded site behind read access. Both the missing and the forbidden case read
 * as "Project not found" so unauthorized callers cannot probe which projects exist. */
function requireReadableSite(
  site: LoadedSite | null,
  user: AuthUser | null,
  config: ServerConfigShape,
): Effect.Effect<LoadedSite, HttpError> {
  if (site == null) return Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
  if (!canReadProject(site.record, user, config)) {
    return Effect.fail(new HttpError({ status: 403, message: "Project not found" }));
  }
  return Effect.succeed(site);
}

/** Rejects API mutations from cross-origin browser requests. */
function rejectCrossOriginApiRequest(
  request: HttpServerRequest.HttpServerRequest,
  baseUrl: string,
): Effect.Effect<void, HttpError> {
  const origin = request.headers.origin;
  if (origin != null && origin !== baseUrl) {
    return Effect.fail(new HttpError({ status: 403, message: "Cross-origin API request rejected" }));
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite === "cross-site") {
    return Effect.fail(new HttpError({ status: 403, message: "Cross-site API request rejected" }));
  }
  return Effect.void;
}

/** Shapes one project record for API responses. */
function projectSummary(record: SiteRecord, contentBase?: string): Record<string, unknown> {
  return {
    workspace: record.workspace,
    project: record.project,
    routePath: record.routePath,
    visibility: record.visibility,
    url: contentBase == null ? undefined : `${contentBase}/${record.routePath}/`,
    owner: record.owner,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    currentOpenPath: record.currentOpenPath,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Published-site serving and the private-content handoff
// ---------------------------------------------------------------------------

/** Authenticates on the app host and sends a one-time handoff token to the content host. */
function issueProjectAccess(request: HttpServerRequest.HttpServerRequest, url: URL): AppEffect {
  return Effect.gen(function* () {
    const routePath = url.searchParams.get("route");
    if (routePath == null) return yield* Effect.fail(new HttpError({ status: 400, message: "Missing route" }));
    const config = yield* ServerConfig;
    const contentBase = contentBaseUrl(request, config);
    const returnTo = safeContentReturnTo(url.searchParams.get("returnTo"), contentBase, routePath)
      ?? `${contentBase}/${routePath}/`;
    const auth = yield* Auth;
    const user = yield* auth.currentUser(request);
    if (user == null) {
      const loginUrl = new URL("/auth/login", appBaseUrl(request, config));
      loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
      return HttpServerResponse.redirect(loginUrl, { status: 302 });
    }

    const siteStore = yield* SiteStore;
    const site = yield* requireReadableSite(yield* siteStore.loadByRoute(routePath), user, config);

    const token = yield* auth.issueProjectAccessToken(projectKey(site.record.workspace, site.record.project), site.record.routePath, user, "handoff");
    const target = new URL(returnTo);
    target.searchParams.set(HANDOFF_PARAM, token);
    return HttpServerResponse.redirect(target.toString(), { status: 302 });
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
    const routePath = site.record.routePath;
    const key = projectKey(site.record.workspace, site.record.project);

    const handoffToken = url.searchParams.get(HANDOFF_PARAM);
    if (handoffToken != null) {
      return yield* redeemHandoffToken(request, url, site, config, auth, handoffToken);
    }

    const cookieUser = yield* projectAccessUser(request, auth, key, site, config);
    if (cookieUser != null) {
      // Everything on the content host is same-origin, so another project's JS could
      // fetch/iframe this project with the viewer's cookie attached. Subresource requests
      // must therefore prove (via Referer, unforgeable from scripts) that the requesting
      // page lives inside this project. Top-level navigations stay unrestricted.
      if (blockedCrossProjectSubresource(request, routePath)) {
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
    const routePath = site.record.routePath;
    // Rebuild the redirect target from the canonical route path so the cookie's Path
    // attribute always matches it, even when the request path was percent-encoded.
    const cleanTarget = canonicalContentPath(url, routePath);
    const user = yield* auth
      .verifyProjectAccessToken(token, projectKey(site.record.workspace, site.record.project), routePath, "handoff")
      .pipe(Effect.orElseSucceed(() => null));
    if (user == null || !canReadProject(site.record, user, config)) {
      return HttpServerResponse.redirect(cleanTarget, { status: 302 });
    }
    const cookieToken = yield* auth.issueProjectAccessToken(projectKey(site.record.workspace, site.record.project), routePath, user, "cookie");
    return HttpServerResponse.redirect(cleanTarget, {
      status: 302,
      headers: {
        "set-cookie": projectAccessCookie(cookieToken, routePath, contentBaseUrl(request, config), config.auth.sessionTtlSeconds),
      },
    });
  });
}

/** Verifies the request's project-access cookies and current read access, if any. */
function projectAccessUser(
  request: HttpServerRequest.HttpServerRequest,
  auth: AuthShape,
  key: string,
  site: LoadedSite,
  config: ServerConfigShape,
): Effect.Effect<AuthUser | null> {
  return Effect.gen(function* () {
    for (const value of projectAccessCookieValues(request, site.record.routePath)) {
      const user = yield* auth
        .verifyProjectAccessToken(value, key, site.record.routePath, "cookie")
        .pipe(Effect.orElseSucceed(() => null));
      // Re-check visibility on every request so revocation applies immediately even
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
  const rest = routeRest(url.pathname, site.record.routePath);
  if (rest == null) {
    return Effect.succeed(HttpServerResponse.redirect(`/${site.record.routePath}/`, { status: 308 }));
  }
  return serveSiteFiles(site, rest, url.search, `/${site.record.routePath}`, isPublic);
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

/** Finds the published site whose route path is the longest matching prefix of the path. */
function loadSiteForPath(
  pathname: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError, SiteStore> {
  return Effect.gen(function* () {
    const siteStore = yield* SiteStore;
    for (const routePath of candidateRoutePaths(pathname)) {
      const site = yield* siteStore.loadByRoute(routePath);
      if (site != null) return site;
    }
    return null;
  });
}

/** Rebuilds the request's clean canonical URL (path + query) on the stored route path,
 * dropping the handoff parameter. */
function canonicalContentPath(url: URL, routePath: string): string {
  const rest = routeRest(url.pathname, routePath) ?? "/";
  const params = new URLSearchParams(url.search);
  params.delete(HANDOFF_PARAM);
  const search = params.toString();
  return `/${routePath}${rest}${search === "" ? "" : `?${search}`}`;
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
  routePath: string,
): boolean {
  if (!isSubresourceRequest(request)) return false;
  const referer = request.headers.referer;
  if (referer == null) return true;
  try {
    return routeRest(new URL(referer).pathname, routePath) == null;
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
  redirect.searchParams.set("route", site.record.routePath);
  redirect.searchParams.set("returnTo", contentRequestUrl(url, contentBaseUrl(request, config)));
  return HttpServerResponse.redirect(redirect, { status: 302 });
}

/** Accepts a returnTo only when it is a clean same-origin URL inside the project route. */
function safeContentReturnTo(value: string | null, contentBase: string, routePath: string): string | null {
  if (value == null || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const base = new URL(contentBase);
    if (url.origin !== base.origin) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== `/${routePath}` && !url.pathname.startsWith(`/${routePath}/`)) return null;
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
// Origins and URLs
// ---------------------------------------------------------------------------

/** Resolves the app-host origin (auth routes, API) for redirects and cookie scoping. */
function appBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly appUrl?: string }): string {
  return publicBaseUrl(request, config.appUrl);
}

/** Resolves the content-host origin (published sites) for redirects and publish URLs. */
function contentBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly contentUrl?: string }): string {
  return publicBaseUrl(request, config.contentUrl);
}

/** Resolves a public origin: the configured value, else the request's own origin. */
function publicBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  configuredPublicUrl: string | undefined,
): string {
  if (configuredPublicUrl != null) return configuredPublicUrl;
  const requestUrl = new URL(request.url, "http://scratchwork.local");
  const requestBase = requestBaseUrl(request, requestUrl);
  if (requestBase != null) return requestBase;
  return requestUrl.origin;
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
  return HttpServerResponse.redirect(target.toString(), { status: 302 });
}

/** Reconstructs the request origin from x-forwarded-host/-proto or the Host header;
 * null when the request carries no usable host information. */
function requestBaseUrl(
  request: HttpServerRequest.HttpServerRequest,
  requestUrl = new URL(request.url, "http://scratchwork.local"),
): string | null {
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = forwardedHost ?? request.headers.host;
  if (host != null && host !== "") {
    const forwardedProto = request.headers["x-forwarded-proto"];
    const proto = forwardedProto ?? defaultProtoForHost(requestUrl, host);
    return `${proto}://${host}`;
  }
  return requestUrl.hostname === "scratchwork.local" ? null : requestUrl.origin;
}

/** Guesses http/https for a Host header when no forwarded proto is present:
 * loopback hosts get http, everything else https. */
function defaultProtoForHost(requestUrl: URL, host: string): "http" | "https" {
  if (requestUrl.hostname !== "scratchwork.local") return requestUrl.protocol === "http:" ? "http" : "https";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "[::1]" || hostname.endsWith(".localhost") ? "http" : "https";
}

/** Returns true when two URL strings share an origin; false for unparsable input. */
function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Builds the user-facing URL returned by publish. */
function publishedUrl(baseUrl: string, routePath: string, openPath: string): string {
  return `${baseUrl}/${routePath}${encodeOpenPath(openPath)}`;
}

/** URL-encodes each path segment without encoding slashes. */
function encodeOpenPath(openPath: string): string {
  return openPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
}
