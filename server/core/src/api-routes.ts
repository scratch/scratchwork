/**
 * The server-owned API route-policy registry (AGENTS.md, invariant 4). Every
 * JSON endpoint is defined exactly once in API_ROUTES: its method and path,
 * how the caller authenticates, the minimum project role it demands, whether
 * it mutates state, and what its response may reveal. The dispatcher below is
 * the only way an API request reaches a handler, and it derives its behavior
 * from the same definitions the policy test matrix enumerates — so an
 * unregistered or policy-less route cannot exist, and unspecified
 * credential/role combinations are denied by construction:
 *
 *  - every route rejects cross-origin browser calls before anything else;
 *  - `auth: "bearer"` resolves the principal or fails 401 before the handler;
 *  - project routes resolve the project and require the declared minimum role
 *    up to "read" before the handler runs, with missing and forbidden both
 *    reading as 404 so unauthorized callers cannot probe which projects
 *    exist; roles above "read" are enforced by the SiteStore operation the
 *    handler calls (they are coupled to its conditional writes) and are
 *    declared here so the policy matrix can assert them end-to-end.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import type * as HttpServerResponse from "@effect/platform/HttpServerResponse";
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
import { accessGroupTerms, isSafeProjectIdentifier } from "./access";
import {
  Auth,
  AuthError,
  createSessionToken,
  decodeCliAuthorizationCode,
  decryptCliCloudflareToken,
  verifyCliCodeExchange,
  type AuthUser,
} from "./auth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { PrimitiveDb } from "./db";
import {
  appBaseUrl,
  contentBaseUrl,
  HttpError,
  jsonResponse,
  projectUrl,
  publishedUrl,
  rejectCrossOriginApiRequest,
} from "./http";
import { readPublishRequest } from "./publish-request";
import { projectForRequest } from "./routes";
import { readShareRequest } from "./share-request";
import { type SiteRecord } from "./site-records";
import {
  canReadProject,
  projectRole,
  roleAtLeast,
  SiteStore,
  SiteStoreError,
  type LoadedSite,
  type ProjectRole,
} from "./site-store";
import { StorageError } from "./storage";

/** Effect type shared by every API handler. */
type ApiEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpError | AuthError | SiteStoreError | StorageError,
  ServerConfig | SiteStore | Auth | PrimitiveDb
>;

/** What the policy middleware hands a handler: the request, its parsed URL,
 * the principal the declared auth mode resolved, and — for project routes —
 * the read-gated project capability. Handlers never reconstruct these. */
export interface ApiContext {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  /** The authenticated principal: non-null for `auth: "bearer"` routes, the
   * optional cookie/bearer identity for `auth: "optional"`, null for
   * `auth: "code-exchange"` (there the one-time code is the credential). */
  readonly user: AuthUser | null;
  /** The loaded project for `/api/projects/:project` routes, already gated by
   * the read-access mask; null on fixed-path routes. */
  readonly site: LoadedSite | null;
}

/** One registered API route and its complete security policy. */
export interface ApiRoute {
  /** Stable route name used by the policy test matrix. */
  readonly name: string;
  readonly method: "GET" | "POST" | "DELETE";
  /** Fixed pathname, or the project-parametrized form "/api/projects/:project(/action)". */
  readonly path: string;
  /**
   * How the caller authenticates. "bearer": a valid bearer session token or
   * 401. "optional": bearer/cookie identity if present, anonymous otherwise.
   * "code-exchange": no ambient credential — the signed one-time code in the
   * body is the credential and the handler verifies it.
   */
  readonly auth: "bearer" | "optional" | "code-exchange";
  /**
   * Minimum project role the route requires. "read" is enforced by the
   * dispatcher's project gate; higher roles are enforced by the SiteStore
   * operation and asserted by the policy matrix. Null for routes without a
   * project subject.
   */
  readonly minimumRole: ProjectRole | null;
  /** Whether a successful call mutates server state. Every route — mutation
   * or not — rejects cross-origin browser calls; the flag feeds the matrix. */
  readonly mutation: boolean;
  /**
   * What the response may reveal. "identity": the caller's own identity.
   * "own-projects": summaries of projects the caller can read.
   * "project-summary": one summary whose `permissions` field (other users'
   * emails) appears only for admin+ callers. "project-content": the full
   * bundle, read-gated. "session-token": a freshly minted credential for the
   * verified code holder. "status": a bare acknowledgment.
   */
  readonly visibility:
    | "identity"
    | "own-projects"
    | "project-summary"
    | "project-content"
    | "session-token"
    | "status";
  readonly handler: (context: ApiContext) => ApiEffect;
}

/** Namespace of the one-time CLI code redemption records. Records are tiny (one per
 * CLI login) and expire with their 60-second codes; they are never read back except
 * by the conditional create that detects a replay. */
const CLI_CODE_NAMESPACE = "cli-code-redemptions";
/** Generous ceiling for the exchange body: three short strings. */
const MAX_CLI_TOKEN_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Handles `POST /auth/cli/token`: the back-channel exchange of a one-time CLI
 * authorization code plus PKCE verifier for a bearer token. */
function exchangeCliToken({ request }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
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

/** Handles `GET /api/me`: reports the caller's own authentication state. */
function me({ user }: ApiContext): ApiEffect {
  return Effect.succeed(jsonResponse({ authenticated: user != null, user }, 200));
}

/** Handles `GET /health`. */
function health(): ApiEffect {
  return Effect.succeed(jsonResponse({ ok: true }, 200));
}

/** Handles `POST /api/publish` through bearer auth and SiteStore (which
 * enforces write — and admin for a public/private flip — on updates). */
function publish({ request, user }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const publishRequest = yield* readPublishRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.publish(publishRequest, user!, config);
    const url = publishedUrl(contentBaseUrl(request, config), result.project, result.openPath, config);
    return jsonResponse({ ...result, url } satisfies PublishResponse, 200);
  });
}

/** Handles `GET /api/projects`: the authenticated user's own project index. */
function listProjects({ request, user }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const siteStore = yield* SiteStore;
    const projects = yield* siteStore.listProjects(user!);
    const contentBase = contentBaseUrl(request, config);
    return jsonResponse({
      projects: projects.map((project) => projectSummary(project, contentBase, projectRole(project, user, config), config)),
    } satisfies ProjectsListResponse, 200);
  });
}

/** Handles `GET /api/resolve`: maps a published content path to its project.
 * Kept as an endpoint (rather than a client-side parse) so validation,
 * authorization, and URL-to-project resolution stay centralized. The project
 * subject comes from the query string, so the read gate runs here rather than
 * in the dispatcher — same mask, same policy. */
function resolveProjectPath({ request, url, user }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const path = url.searchParams.get("path");
    if (path == null || !path.startsWith("/")) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Missing path" }));
    }
    const config = yield* ServerConfig;
    const siteStore = yield* SiteStore;
    const project = projectForRequest(path);
    const loaded = project == null ? null : yield* siteStore.loadProject(project);
    const site = yield* requireReadableSite(loaded, user, config);
    return jsonResponse({
      project: projectSummary(site.record, contentBaseUrl(request, config), projectRole(site.record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Handles `GET /api/projects/:project`. */
function projectInfo({ request, user, site }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    return jsonResponse({
      project: projectSummary(site!.record, contentBaseUrl(request, config), projectRole(site!.record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Handles `GET /api/projects/:project/bundle` for clone/read workflows. */
function projectBundle({ site }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const siteStore = yield* SiteStore;
    const bundle = yield* siteStore.bundle(site!.record.project);
    if (bundle == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    return jsonResponse({ bundle }, 200);
  });
}

/** Handles `POST /api/projects/:project/unpublish` (SiteStore enforces admin). */
function unpublishProject({ request, user, site }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const siteStore = yield* SiteStore;
    const record = yield* siteStore.unpublish(site!.record.project, user!, config);
    return jsonResponse({
      project: projectSummary(record, contentBaseUrl(request, config), projectRole(record, user, config), config),
    } satisfies ProjectResponse, 200);
  });
}

/** Handles `POST /api/projects/:project/share` (SiteStore enforces admin). */
function shareProject({ request, user, site }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const changes = yield* readShareRequest(request);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.share(site!.record.project, user!, changes, config);
    return jsonResponse({
      project: projectSummary(result.record, contentBaseUrl(request, config), projectRole(result.record, user, config), config),
      warnings: result.warnings,
    } satisfies ShareResponse, 200);
  });
}

/** Handles `DELETE /api/projects/:project` (SiteStore enforces owner). */
function deleteProject({ user, site }: ApiContext): ApiEffect {
  return Effect.gen(function* () {
    const siteStore = yield* SiteStore;
    yield* siteStore.deleteProject(site!.record.project, user!);
    return jsonResponse({ ok: true }, 200);
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every JSON endpoint this server exposes, with its complete policy. */
export const API_ROUTES: ReadonlyArray<ApiRoute> = [
  { name: "health", method: "GET", path: "/health", auth: "optional", minimumRole: null, mutation: false, visibility: "status", handler: health },
  { name: "cli-token-exchange", method: "POST", path: "/auth/cli/token", auth: "code-exchange", minimumRole: null, mutation: true, visibility: "session-token", handler: exchangeCliToken },
  { name: "me", method: "GET", path: "/api/me", auth: "optional", minimumRole: null, mutation: false, visibility: "identity", handler: me },
  { name: "publish", method: "POST", path: "/api/publish", auth: "bearer", minimumRole: "write", mutation: true, visibility: "project-summary", handler: publish },
  { name: "projects-list", method: "GET", path: "/api/projects", auth: "bearer", minimumRole: null, mutation: false, visibility: "own-projects", handler: listProjects },
  { name: "resolve", method: "GET", path: "/api/resolve", auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-summary", handler: resolveProjectPath },
  { name: "project-info", method: "GET", path: "/api/projects/:project", auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-summary", handler: projectInfo },
  { name: "project-bundle", method: "GET", path: "/api/projects/:project/bundle", auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-content", handler: projectBundle },
  { name: "project-unpublish", method: "POST", path: "/api/projects/:project/unpublish", auth: "bearer", minimumRole: "admin", mutation: true, visibility: "project-summary", handler: unpublishProject },
  { name: "project-share", method: "POST", path: "/api/projects/:project/share", auth: "bearer", minimumRole: "admin", mutation: true, visibility: "project-summary", handler: shareProject },
  { name: "project-delete", method: "DELETE", path: "/api/projects/:project", auth: "bearer", minimumRole: "owner", mutation: true, visibility: "status", handler: deleteProject },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes one request through the registry, or returns null when the path
 * belongs to no registered route family (auth pages and published content are
 * dispatched elsewhere). A registered path with the wrong method is 405; an
 * unknown path under /api/ is 404 — both decided here so nothing else can
 * answer for API paths.
 */
export function dispatchApiRoute(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse | null,
  HttpError | AuthError | SiteStoreError | StorageError,
  ServerConfig | SiteStore | Auth | PrimitiveDb
> {
  return Effect.gen(function* () {
    const matches = API_ROUTES
      .map((route) => ({ route, params: matchPath(route.path, url.pathname) }))
      .filter((match) => match.params != null);
    if (matches.length === 0) {
      if (url.pathname.startsWith("/api/")) {
        return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
      }
      return null;
    }
    // HEAD is answered by the matching GET route, per HTTP semantics.
    const method = request.method === "HEAD" ? "GET" : request.method;
    const match = matches.find((candidate) => candidate.route.method === method);
    if (match == null) {
      return yield* Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
    }
    return yield* runRoute(match.route, match.params!.project ?? null, request, url);
  });
}

/** Applies the declared policy in order — origin, principal, project gate —
 * then runs the handler with the resolved context. */
function runRoute(
  route: ApiRoute,
  project: string | null,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): ApiEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));

    const auth = yield* Auth;
    const user = route.auth === "bearer"
      ? yield* auth.requireApiUser(request)
      : route.auth === "optional"
        ? yield* auth.currentUser(request)
        : null;

    let site: LoadedSite | null = null;
    if (project != null) {
      const siteStore = yield* SiteStore;
      site = yield* requireReadableSite(yield* siteStore.loadProject(project), user, config);
    }
    return yield* route.handler({ request, url, user, site });
  });
}

/** Matches a registry path pattern against a request pathname. The decoded
 * :project segment is validated so malformed names become a 404 instead of
 * reaching the store as backend keys. Returns null on no match. */
function matchPath(pattern: string, pathname: string): { readonly project?: string } | null {
  if (!pattern.includes(":project")) return pattern === pathname ? {} : null;
  const match = /^\/api\/projects\/([^/]+)(\/[^/]+)?$/.exec(pathname);
  if (match == null) return null;
  const suffix = match[2] ?? "";
  if (pattern !== `/api/projects/:project${suffix}`) return null;
  try {
    const project = decodeURIComponent(match[1]);
    return isSafeProjectIdentifier(project) ? { project } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared gates and response shaping
// ---------------------------------------------------------------------------

/** Gates a loaded site behind read access. Both the missing and the forbidden case read
 * as "Project not found" so unauthorized callers cannot probe which projects exist. */
export function requireReadableSite(
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

/** Shapes one project record for API responses (the shared ProjectInfo contract).
 * `isPublic` is the public/private toggle; `permissions` lists the per-role grants and
 * names other users' emails, so it is shown only to admins and the owner (the caller's
 * role decides, never appears in the payload). */
export function projectSummary(record: SiteRecord, contentBase: string, callerRole: ProjectRole, config: ServerConfigShape): ProjectInfo {
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
