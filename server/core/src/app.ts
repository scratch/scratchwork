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
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import {
  CliTokenRequestSchema,
  type CliTokenRequest,
  type CliTokenResponse,
  type ProjectInfo,
  type ProjectResponse,
  type ProjectsListResponse,
  type PublishResponse,
  type ShareResponse,
} from "../../../shared/src/publish/api";
import { SiteFiles } from "../../../shared/src/site/files";
import { servePath } from "../../../shared/src/site/serve";
import { isLoopbackHost } from "../../../shared/src/util/url";
import { defaultRendererHtml } from "../../../shared/src/site/default-renderer.generated.js";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { accessGroupTerms, isSafeProjectIdentifier } from "./access";
import {
  Auth,
  AuthError,
  createSessionToken,
  decodeCliAuthorizationCode,
  decryptCliCloudflareToken,
  verifyCliCodeExchange,
  type AuthShape,
  type AuthUser,
} from "./auth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { PrimitiveDb } from "./db";
import { projectAccessCookie, projectAccessCookieValues } from "./cookies";
import { acceptsHtmlPage, errorPageResponse, errorResponse } from "./error-pages";
import { HttpError, jsonResponse, securityHeaders } from "./http";
import { readPublishRequest } from "./publish-request";
import { readShareRequest } from "./share-request";
import { projectForRequest, routeRest } from "./routes";
import { type SiteRecord } from "./site-records";
import { canReadProject, projectRole, roleAtLeast, SiteStore, SiteStoreError, type LoadedSite, type ProjectRole } from "./site-store";
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

    if (url.pathname === "/auth/cli/token") {
      if (request.method !== "POST") {
        return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
      }
      return yield* exchangeCliToken(request);
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
      if (request.method === "GET" && projectApi.action == null) return yield* projectInfo(request, projectApi.project);
      if (request.method === "GET" && projectApi.action === "bundle") return yield* projectBundle(request, projectApi.project);
      if (request.method === "POST" && projectApi.action === "unpublish") return yield* unpublishProject(request, projectApi.project);
      if (request.method === "POST" && projectApi.action === "share") return yield* shareProject(request, projectApi.project);
      if (request.method === "DELETE" && projectApi.action == null) return yield* deleteProject(request, projectApi.project);
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }

    if (url.pathname.startsWith("/api/")) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

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

/** Parses /api/projects/:project(/:action) paths; null when it is not one. The decoded
 * project segment is validated here so malformed names become a 404 instead of reaching
 * the store as backend keys. */
function projectApiPath(pathname: string): { readonly project: string; readonly action?: "unpublish" | "bundle" | "share" } | null {
  const match = /^\/api\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (match == null) return null;
  const action = match[2];
  if (action != null && action !== "unpublish" && action !== "bundle" && action !== "share") return null;
  try {
    const project = decodeURIComponent(match[1]);
    if (!isSafeProjectIdentifier(project)) return null;
    return { project, action: action as "unpublish" | "bundle" | "share" | undefined };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

/** Namespace of the one-time CLI code redemption records. Records are tiny (one per
 * CLI login) and expire with their 60-second codes; they are never read back except
 * by the conditional create that detects a replay. */
const CLI_CODE_NAMESPACE = "cli-code-redemptions";
/** Generous ceiling for the exchange body: three short strings. */
const MAX_CLI_TOKEN_BODY_BYTES = 64 * 1024;

/** Handles `POST /auth/cli/token`: the back-channel exchange of a one-time CLI
 * authorization code plus PKCE verifier for a bearer token. The code — not a
 * cookie — is the credential, so the route requires no session; the cross-origin
 * rejection still applies so a browser page cannot drive it. */
function exchangeCliToken(request: HttpServerRequest.HttpServerRequest): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const db = yield* PrimitiveDb;
    const body = yield* readCliTokenRequest(request);
    const payload = yield* decodeCliAuthorizationCode(body.code, config.auth);
    // Burn the code before checking possession: the first redemption attempt
    // consumes it, so an intercepted code that is replayed — or raced with a wrong
    // verifier — fails closed instead of staying redeemable within its lifetime.
    yield* db.put(
      CLI_CODE_NAMESPACE,
      payload.id,
      { redeemedAt: Math.floor(Date.now() / 1000) },
      { ifNoneMatch: "*", expiresAt: payload.expiresAt },
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "PrimitiveDbConflict"
          ? new AuthError({ status: 400, message: "Authorization code already redeemed" })
          : new HttpError({ status: 500, message: "Could not record the code redemption" }),
      ),
    );
    const user = yield* verifyCliCodeExchange(payload, body.codeVerifier, body.redirectUri, config.auth);
    const cfToken = yield* decryptCliCloudflareToken(payload, config.auth);
    const token = yield* createSessionToken(user, config.auth);
    const response: CliTokenResponse = {
      token,
      server: appBaseUrl(request, config),
      email: user.email,
      ...(cfToken != null ? { cfToken } : {}),
    };
    return jsonResponse(response, 200);
  });
}

/** Reads, size-limits, and strictly decodes the CLI token-exchange body. */
function readCliTokenRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<CliTokenRequest, HttpError> {
  return Effect.gen(function* () {
    const text = yield* request.text.pipe(
      HttpServerRequest.withMaxBodySize(Option.some(MAX_CLI_TOKEN_BODY_BYTES)),
      Effect.mapError((cause) => new HttpError({ status: 413, message: "Request body is too large", cause })),
    );
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(text).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "Invalid JSON body" })),
    );
    return yield* Schema.decodeUnknown(CliTokenRequestSchema)(parsed, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) =>
        new HttpError({ status: 400, message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );
  });
}

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
    const url = publishedUrl(contentBaseUrl(request, config), result.project, result.openPath, config);
    return jsonResponse({ ...result, url } satisfies PublishResponse, 200);
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
    const contentBase = contentBaseUrl(request, config);
    return jsonResponse({
      projects: projects.map((project) => projectSummary(project, contentBase, projectRole(project, user, config), config)),
    } satisfies ProjectsListResponse, 200);
  });
}

/** Resolves a published content path to its project. Kept as an endpoint (rather than a
 * client-side parse) so validation, authorization, and URL-to-project resolution stay
 * centralized on the server. */
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
    return jsonResponse({
      project: projectSummary(site.record, contentBaseUrl(request, config), projectRole(site.record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Returns metadata for one project. */
function projectInfo(request: HttpServerRequest.HttpServerRequest, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const site = yield* requireReadableSite(yield* siteStore.loadProject(project), user, config);
    return jsonResponse({
      project: projectSummary(site.record, contentBaseUrl(request, config), projectRole(site.record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Returns the current project bundle for clone/read workflows. */
function projectBundle(request: HttpServerRequest.HttpServerRequest, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    yield* requireReadableSite(yield* siteStore.loadProject(project), user, config);
    const bundle = yield* siteStore.bundle(project);
    if (bundle == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    return jsonResponse({ bundle }, 200);
  });
}

/** Makes a project owner-only: private and with every grant cleared. */
function unpublishProject(request: HttpServerRequest.HttpServerRequest, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    const record = yield* siteStore.unpublish(project, user, config);
    return jsonResponse({
      project: projectSummary(record, contentBaseUrl(request, config), projectRole(record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Grants or revokes email/@domain access by editing the project's grant groups. */
function shareProject(request: HttpServerRequest.HttpServerRequest, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const changes = yield* readShareRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.share(project, user, changes, config);
    return jsonResponse({
      project: projectSummary(result.record, contentBaseUrl(request, config), projectRole(result.record, user, config), config),
      warnings: result.warnings,
    } satisfies ShareResponse, 200);
  });
}

/** Deletes a project pointer and owner index, releasing the name. */
function deleteProject(request: HttpServerRequest.HttpServerRequest, project: string): AppEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));
    const auth = yield* Auth;
    const user = yield* auth.requireApiUser(request);
    const siteStore = yield* SiteStore;
    yield* siteStore.deleteProject(project, user);
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

/** Shapes one project record for API responses (the shared ProjectInfo contract).
 * `isPublic` is the public/private toggle; `permissions` lists the per-role grants and
 * names other users' emails, so it is shown only to admins and the owner (the caller's
 * role decides, never appears in the payload). */
function projectSummary(record: SiteRecord, contentBase: string, callerRole: ProjectRole, config: ServerConfigShape): ProjectInfo {
  const permissions = roleAtLeast(callerRole, "admin")
    ? {
        permissions: {
          read: accessGroupTerms(record.readers),
          write: accessGroupTerms(record.writers),
          admin: accessGroupTerms(record.admins),
        },
      }
    : {};
  return {
    project: record.project,
    isPublic: record.isPublic,
    ...permissions,
    url: projectUrl(record.project, contentBase, config),
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
  // Preserve the method and body for the CLI's token-exchange POST. Browser auth
  // routes remain ordinary GET redirects.
  return HttpServerResponse.redirect(target.toString(), {
    status: request.method === "GET" || request.method === "HEAD" ? 302 : 307,
  });
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
  return isLoopbackHost(host.replace(/:\d+$/, "")) ? "http" : "https";
}

/** Returns true when two URL strings share an origin; false for unparsable input. */
function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Builds the user-facing URL returned by publish. The homepage project reports its
 * canonical home origin; every other project reports its content route. */
function publishedUrl(baseUrl: string, project: string, openPath: string, config: ServerConfigShape): string {
  const homepageBase = homepageBaseUrl(project, config);
  if (homepageBase != null) return `${homepageBase}${encodeOpenPath(openPath)}`;
  return `${baseUrl}/${encodeURIComponent(project)}${encodeOpenPath(openPath)}`;
}

/** The user-facing root URL of one project (see publishedUrl). */
function projectUrl(project: string, contentBase: string, config: ServerConfigShape): string {
  const homepageBase = homepageBaseUrl(project, config);
  if (homepageBase != null) return `${homepageBase}/`;
  return `${contentBase}/${encodeURIComponent(project)}/`;
}

/** The canonical home origin when the project is the configured homepage, else null. */
function homepageBaseUrl(project: string, config: ServerConfigShape): string | null {
  return config.homepageProject != null && project === config.homepageProject
    ? config.homepageUrls[0] ?? null
    : null;
}

/** URL-encodes each path segment without encoding slashes. */
function encodeOpenPath(openPath: string): string {
  return openPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
}
