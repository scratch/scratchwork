import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { SiteFileError, SiteFiles } from "../../../shared/src/site/files";
import { servePath } from "../../../shared/src/site/serve";
import { defaultRendererHtml } from "../../../shared/src/site/default-renderer.generated.js";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { Auth, AuthError } from "./auth";
import { ServerConfig } from "./config";
import { errorJson, HttpError, jsonResponse, securityHeaders } from "./http-error";
import { readPublishRequest } from "./publish-request";
import {
  canReadProject,
  candidateRoutePaths,
  projectKey,
  routeRest,
  SiteStore,
  SiteStoreError,
  type LoadedSite,
} from "./site-store";
import { StorageError } from "./storage";

const NO_STORE = "no-store, must-revalidate";
/**
 * Reserved first path segment carrying a signed project-access token for private content,
 * e.g. `/_a/<token>/<routePath>/...`. The token lives in the path (not a cookie) so that
 * relative subresource fetches from the sandboxed, opaque-origin content page inherit it —
 * a `SameSite` cookie is never attached to those cross-site subresource requests. `_a` starts
 * with an underscore, so it can never collide with a route path (identifiers must start
 * alphanumeric).
 */
const CONTENT_ACCESS_PREFIX = "_a";

export const app: HttpApp.Default<never, ServerConfig | SiteStore | Auth> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(request).pipe(
      Effect.catchTags({
        HttpError: (error) => errorJson(error.status, error.message),
        AuthError: (error) => errorJson(error.status, error.message),
        SiteStoreError: (error) => errorJson(error.status, error.message),
        StorageError: (error) => errorJson(500, error.message),
      }),
    );
  });

/** Routes one HTTP request to auth, API, health, or published-site handling. */
function handleRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
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
      return yield* jsonResponse({ ok: true }, 200);
    }

    if (url.pathname === "/api/me") {
      const auth = yield* Auth;
      const user = yield* auth.currentUser(request);
      return yield* jsonResponse({ authenticated: user != null, user }, 200);
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

/** Handles `POST /api/publish` through bearer auth and SiteStore. */
function publish(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const publishRequest = yield* readPublishRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.publish(publishRequest, user, config);
    const url = publishedUrl(contentBaseUrl(request, config), result.routePath, result.openPath);
    return yield* jsonResponse({ ...result, url }, 200);
  });
}

/** Lists projects visible in the authenticated user's owner index. */
function listProjects(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const projects = yield* siteStore.listProjects(user);
    return yield* jsonResponse({ projects: projects.map((project) => projectSummary(project)) }, 200);
  });
}

/** Resolves a published content path (under any route strategy) to its project. */
function resolveProjectPath(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const path = url.searchParams.get("path");
    if (path == null || !path.startsWith("/")) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Missing path" }));
    }
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const site = yield* loadSiteForPath(path);
    if (site == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    if (!canReadProject(site.record, user, config)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Project not found" }));
    }
    return yield* jsonResponse({ project: projectSummary(site.record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Returns metadata for one project. */
function projectInfo(
  request: HttpServerRequest.HttpServerRequest,
  workspace: string,
  project: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const site = yield* siteStore.loadProject(workspace, project);
    if (site == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    if (!canReadProject(site.record, user, config)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Project not found" }));
    }
    return yield* jsonResponse({ project: projectSummary(site.record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Returns the current project bundle for clone/read workflows. */
function projectBundle(
  request: HttpServerRequest.HttpServerRequest,
  workspace: string,
  project: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const site = yield* siteStore.loadProject(workspace, project);
    if (site == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    if (!canReadProject(site.record, user, config)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Project not found" }));
    }
    const bundle = yield* siteStore.bundle(workspace, project);
    if (bundle == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    return yield* jsonResponse({ bundle }, 200);
  });
}

/** Makes a project owner-only by setting visibility to private. */
function unpublishProject(
  request: HttpServerRequest.HttpServerRequest,
  workspace: string,
  project: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const record = yield* siteStore.unpublish(workspace, project, user);
    return yield* jsonResponse({ project: projectSummary(record, contentBaseUrl(request, config)) }, 200);
  });
}

/** Deletes a project pointer and route index. */
function deleteProject(
  request: HttpServerRequest.HttpServerRequest,
  workspace: string,
  project: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    yield* siteStore.deleteProject(workspace, project, user);
    return yield* jsonResponse({ ok: true }, 200);
  });
}

/** Authenticates on the app host and sends a one-time content token to the content host. */
function issueProjectAccess(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
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
    const site = yield* siteStore.loadByRoute(routePath);
    if (site == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    if (!canReadProject(site.record, user, config)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Project not found" }));
    }

    const token = yield* auth.issueProjectAccessToken(projectKey(site.record.workspace, site.record.project), site.record.routePath, user);
    return HttpServerResponse.redirect(tokenizedContentUrl(returnTo, token), { status: 302 });
  });
}

/** Routes a published-content request to tokenized (private) or clean (public) serving. */
function servePublishedSite(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const access = parseAccessPrefix(url.pathname);
    if (access != null) {
      return yield* serveTokenizedContent(request, url, access);
    }
    return yield* serveCleanContent(request, url);
  });
}

/** Serves private content addressed as `/_a/<token>/<routePath>/...` after verifying the token. */
function serveTokenizedContent(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  access: { readonly token: string; readonly innerPath: string },
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
  return Effect.gen(function* () {
    const site = yield* loadSiteForPath(access.innerPath);
    if (site == null) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }
    const auth = yield* Auth;
    const config = yield* ServerConfig;
    const tokenUser = yield* auth
      .verifyProjectAccessToken(access.token, projectKey(site.record.workspace, site.record.project), site.record.routePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (tokenUser == null || !canReadProject(site.record, tokenUser, config)) {
      // Missing/expired/mismatched token, or access revoked since issuance: bounce to the
      // clean URL, which re-runs the app-host authentication handoff and mints a fresh token.
      return HttpServerResponse.redirect(`${access.innerPath}${url.search}`, { status: 302 });
    }

    const prefix = `/${CONTENT_ACCESS_PREFIX}/${access.token}/${site.record.routePath}`;
    const rest = routeRest(access.innerPath, site.record.routePath);
    if (rest == null) {
      return HttpServerResponse.redirect(`${prefix}/`, { status: 308 });
    }
    return yield* serveSiteFiles(site, rest, url.search, prefix);
  });
}

/** Serves public content at its clean URL, or sends private content through the auth handoff. */
function serveCleanContent(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError | AuthError | SiteStoreError | StorageError, ServerConfig | SiteStore | Auth> {
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
    // Only anonymously-readable (public) projects serve at their clean URL. Anything gated
    // is redirected to the app host, which authenticates the viewer and returns a token-prefixed
    // URL so sandboxed subresource fetches (which carry no cookies) stay authenticated.
    if (!canReadProject(site.record, null, config)) {
      return projectAccessRedirect(request, url, site, config);
    }

    const rest = routeRest(url.pathname, site.record.routePath);
    if (rest == null) {
      return HttpServerResponse.redirect(`/${site.record.routePath}/`, { status: 308 });
    }
    return yield* serveSiteFiles(site, rest, url.search, `/${site.record.routePath}`);
  });
}

/** Serves one file from a loaded site under the given canonical path prefix. */
function serveSiteFiles(
  site: LoadedSite,
  rest: string,
  search: string,
  pathPrefix: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError, ServerConfig> {
  return servePath(rest, search, {
    cacheControl: () => NO_STORE,
    defaultFaviconSvg: FIGURE_SVG,
    headers: publishedSiteHeaders,
    pathPrefix,
    rendererFallback: Effect.succeed(defaultRendererHtml),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SiteFileError
        ? new HttpError({ status: 500, message: error.message })
        : error,
    ),
    Effect.provideService(SiteFiles, site.siteFiles),
  );
}

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

/** Adds isolation and static-asset headers for published content. */
function publishedSiteHeaders(path: string, responseContentType: string): Record<string, string> {
  const headers = securityHeaders();
  headers["Access-Control-Allow-Origin"] = "*";
  if (responseContentType.startsWith("text/html") || responseContentType === "image/svg+xml") {
    headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-downloads; base-uri 'none'";
  }
  if (path.endsWith(".md")) {
    headers["X-Content-Type-Options"] = "nosniff";
  }
  return headers;
}

/** Resolves the public origin used in redirects and publish responses. */
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

function appBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly appUrl?: string; readonly publicUrl?: string }): string {
  return publicBaseUrl(request, config.appUrl ?? config.publicUrl);
}

function contentBaseUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly contentUrl?: string; readonly publicUrl?: string }): string {
  return publicBaseUrl(request, config.contentUrl ?? config.publicUrl);
}

/** Sends auth routes to the configured app origin before setting host-bound cookies. */
function canonicalAppRedirect(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  config: { readonly appUrl?: string; readonly publicUrl?: string },
): HttpServerResponse.HttpServerResponse | null {
  const appBase = appBaseUrl(request, config);
  const requestBase = requestBaseUrl(request);
  if (requestBase == null || sameOrigin(requestBase, appBase)) return null;
  const target = new URL(`${url.pathname}${url.search}`, appBase);
  return HttpServerResponse.redirect(target.toString(), { status: 302 });
}

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

function defaultProtoForHost(requestUrl: URL, host: string): "http" | "https" {
  if (requestUrl.hostname !== "scratchwork.local") return requestUrl.protocol === "http:" ? "http" : "https";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "[::1]" ? "http" : "https";
}

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

function projectSummary(
  record: LoadedSite["record"],
  contentBase?: string,
): Record<string, unknown> {
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

/** Splits `/_a/<token>/<rest...>` into the token and the remaining content path, or null. */
function parseAccessPrefix(pathname: string): { readonly token: string; readonly innerPath: string } | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2 || segments[0] !== CONTENT_ACCESS_PREFIX) return null;
  let token: string;
  try {
    token = decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
  const innerSegments = segments.slice(2);
  const trailingSlash = innerSegments.length > 0 && pathname.endsWith("/");
  const innerPath = `/${innerSegments.join("/")}${trailingSlash ? "/" : ""}`;
  return { token, innerPath };
}

/** Rewrites a validated content return URL into its token-prefixed form `/_a/<token>/...`. */
function tokenizedContentUrl(returnTo: string, token: string): string {
  const target = new URL(returnTo);
  target.pathname = `/${CONTENT_ACCESS_PREFIX}/${token}${target.pathname}`;
  return target.toString();
}

function projectAccessRedirect(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: { readonly appUrl?: string; readonly contentUrl?: string; readonly publicUrl?: string },
): HttpServerResponse.HttpServerResponse {
  const redirect = new URL("/auth/project", appBaseUrl(request, config));
  redirect.searchParams.set("route", site.record.routePath);
  redirect.searchParams.set("returnTo", contentRequestUrl(url, contentBaseUrl(request, config)));
  return HttpServerResponse.redirect(redirect, { status: 302 });
}

function contentRequestUrl(url: URL, contentBase: string): string {
  return new URL(`${url.pathname}${url.search}`, contentBase).toString();
}

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
