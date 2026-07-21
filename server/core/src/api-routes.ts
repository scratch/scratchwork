/**
 * The server-owned API route-policy registry (AGENTS.md, invariant 4), keyed
 * by the shared HttpApi contract (invariant 2). The contract object
 * (ScratchworkApi in shared/src/publish/api.ts) is the single definition of
 * every JSON endpoint's method, path, request payload, and success schema;
 * API_POLICY below attaches the server's security policy and handler to every
 * contract endpoint — the mapped type makes a contract endpoint without a
 * policy (or a policy for a nonexistent endpoint) a compile error, and each
 * handler's return type is checked against and encoded through the endpoint's
 * declared success schema, so a response that drifts from the contract cannot
 * typecheck. The dispatcher below is the only way an API request reaches a
 * handler, and it derives its match table from the same definitions the
 * policy test matrix enumerates — so an unregistered or policy-less route
 * cannot exist, and unspecified credential/role combinations are denied by
 * construction:
 *
 *  - every route rejects cross-origin browser calls before anything else;
 *  - `auth: "bearer"` resolves the principal or fails 401 before the handler;
 *  - project routes resolve the project and require the declared minimum role
 *    up to "read" before the handler runs, with missing and forbidden both
 *    reading as 404 so unauthorized callers cannot probe which projects
 *    exist; roles above "read" are enforced by the SiteStore operation the
 *    handler calls (they are coupled to its conditional writes) and are
 *    declared here so the policy matrix can assert them end-to-end;
 *  - request bodies are size-capped per route and decoded strictly (errors:
 *    "all", onExcessProperty: "error") through the contract payload schema
 *    before the handler runs.
 */
import type * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import type * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import {
  ScratchworkApi,
  type EndpointPayload,
  type EndpointSuccess,
  type ProjectInfo,
  type ScratchworkEndpointName,
} from "@scratchwork/shared/publish/api";
import { accessGroupTerms, isSafeProjectIdentifier } from "./access.ts";
import {
  Auth,
  AuthError,
  createSessionToken,
  decodeCliAuthorizationCode,
  decryptCliCloudflareToken,
  verifyCliCodeExchange,
  type AuthUser,
} from "./auth.ts";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { PrimitiveDb } from "./db.ts";
import {
  appBaseUrl,
  contentBaseUrl,
  HttpError,
  jsonResponse,
  projectUrl,
  publishedUrl,
  rejectCrossOriginApiRequest,
} from "./http.ts";
import { MAX_PUBLISH_BODY_BYTES, normalizePublishRequest } from "./publish-request.ts";
import { projectForRequest } from "./routes.ts";
import { MAX_SHARE_BODY_BYTES, validateShareChanges } from "./share-request.ts";
import { type SiteRecord } from "./site-records.ts";
import {
  canReadProject,
  projectRole,
  roleAtLeast,
  SiteStore,
  SiteStoreError,
  type LoadedSite,
  type ProjectRole,
} from "./site-store.ts";
import { StorageError } from "./storage.ts";

/** Failures any API handler may raise. */
type RouteError = HttpError | AuthError | SiteStoreError | StorageError;

/** Services available to every API handler. */
type RouteServices = ServerConfig | SiteStore | Auth | PrimitiveDb;

/** What the policy middleware hands a handler: the request, its parsed URL,
 * the principal the declared auth mode resolved, for project routes the
 * read-gated project capability, and for payload endpoints the strictly
 * decoded body. Handlers never reconstruct these. */
export interface ApiContext<Name extends ScratchworkEndpointName = ScratchworkEndpointName> {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  /** The authenticated principal: non-null for `auth: "bearer"` routes, the
   * optional cookie/bearer identity for `auth: "optional"`, null for
   * `auth: "code-exchange"` (there the one-time code is the credential). */
  readonly user: AuthUser | null;
  /** The loaded project for `/api/projects/:project` routes, already gated by
   * the read-access mask; null on fixed-path routes. */
  readonly site: LoadedSite | null;
  /** The request body, size-capped and strictly decoded through the contract
   * payload schema; `never` for endpoints that declare no payload. */
  readonly payload: EndpointPayload<Name>;
}

/** The size cap applied while reading a payload endpoint's request body. */
interface PayloadLimit {
  readonly maxBytes: number;
  /** The message of the 413 an oversized body receives. */
  readonly message: string;
}

/** The security policy and handler attached to one contract endpoint. The
 * handler must return the endpoint's declared success type; endpoints that
 * declare a payload must declare a body size cap. */
type ApiPolicy<Name extends ScratchworkEndpointName> = {
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
  readonly handler: (context: ApiContext<Name>) => Effect.Effect<EndpointSuccess<Name>, RouteError, RouteServices>;
} & ([EndpointPayload<Name>] extends [never] ? { readonly payloadLimit?: undefined }
  : { readonly payloadLimit: PayloadLimit });

/** One registered API route: a contract endpoint joined with its policy. */
export interface ApiRoute {
  /** Stable route name (the contract endpoint name) used by the policy test matrix. */
  readonly name: ScratchworkEndpointName;
  readonly method: string;
  /** The contract path: fixed, or the project-parametrized form
   * "/api/projects/:project(/action)". */
  readonly path: string;
  readonly auth: ApiPolicy<ScratchworkEndpointName>["auth"];
  readonly minimumRole: ProjectRole | null;
  readonly mutation: boolean;
  readonly visibility: ApiPolicy<ScratchworkEndpointName>["visibility"];
}

/** An ApiRoute with the internals dispatch needs (type-erased handler). */
interface RegisteredRoute extends ApiRoute {
  readonly endpoint: HttpApiEndpoint.HttpApiEndpoint.AnyWithProps;
  readonly payloadLimit: PayloadLimit | undefined;
  readonly handler: (context: ApiContext<never>) => Effect.Effect<unknown, RouteError, RouteServices>;
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
function exchangeCliToken({ request, payload }: ApiContext<"cli-token-exchange">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const db = yield* PrimitiveDb;
    const code = yield* decodeCliAuthorizationCode(payload.code, config.auth);
    // Burn the code before checking possession: the first redemption attempt
    // consumes it, so an intercepted code that is replayed — or raced with a wrong
    // verifier — fails closed instead of staying redeemable within its lifetime.
    yield* db.put(
      CLI_CODE_NAMESPACE,
      code.id,
      { redeemedAt: Math.floor(Date.now() / 1000) },
      { ifNoneMatch: "*", expiresAt: code.expiresAt },
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "PrimitiveDbConflict"
          ? new AuthError({ status: 400, message: "Authorization code already redeemed" })
          : new HttpError({ status: 500, message: "Could not record the code redemption" }),
      ),
    );
    const user = yield* verifyCliCodeExchange(code, payload.codeVerifier, payload.redirectUri, config.auth);
    const cfToken = yield* decryptCliCloudflareToken(code, config.auth);
    const token = yield* createSessionToken(user, config.auth);
    return {
      token,
      server: appBaseUrl(request, config),
      email: user.email,
      ...(cfToken != null ? { cfToken } : {}),
    };
  });
}

/** Handles `GET /api/me`: reports the caller's own authentication state. */
function me({ user }: ApiContext<"me">) {
  return Effect.succeed({ authenticated: user != null, user });
}

/** Handles `GET /health`. */
function health() {
  return Effect.succeed({ ok: true });
}

/** Handles `POST /api/publish` through bearer auth and SiteStore (which
 * enforces write — and admin for a public/private flip — on updates). */
function publish({ request, user, payload }: ApiContext<"publish">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const publishRequest = yield* normalizePublishRequest(payload);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.publish(publishRequest, user!, config);
    const url = publishedUrl(contentBaseUrl(request, config), result.project, result.openPath, config);
    return { ...result, url };
  });
}

/** Handles `GET /api/projects`: the authenticated user's own project index. */
function listProjects({ request, user }: ApiContext<"projects-list">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const siteStore = yield* SiteStore;
    const projects = yield* siteStore.listProjects(user!);
    const contentBase = contentBaseUrl(request, config);
    return {
      projects: projects.map((project) => projectSummary(project, contentBase, projectRole(project, user, config), config)),
    };
  });
}

/** Handles `GET /api/resolve`: maps a published content path to its project.
 * Kept as an endpoint (rather than a client-side parse) so validation,
 * authorization, and URL-to-project resolution stay centralized. The project
 * subject comes from the query string, so the read gate runs here rather than
 * in the dispatcher — same mask, same policy. */
function resolveProjectPath({ request, url, user }: ApiContext<"resolve">) {
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
    return {
      project: projectSummary(site.record, contentBaseUrl(request, config), projectRole(site.record, user, config), config),
    };
  });
}

/** Handles `GET /api/projects/:project`. */
function projectInfo({ request, user, site }: ApiContext<"project-info">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    return {
      project: projectSummary(site!.record, contentBaseUrl(request, config), projectRole(site!.record, user, config), config),
    };
  });
}

/** Handles `GET /api/projects/:project/bundle` for clone/read workflows. */
function projectBundle({ site }: ApiContext<"project-bundle">) {
  return Effect.gen(function* () {
    const siteStore = yield* SiteStore;
    const bundle = yield* siteStore.bundle(site!.record.project);
    if (bundle == null) return yield* Effect.fail(new HttpError({ status: 404, message: "Project not found" }));
    return { bundle };
  });
}

/** Handles `POST /api/projects/:project/unpublish` (SiteStore enforces admin). */
function unpublishProject({ request, user, site }: ApiContext<"project-unpublish">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const siteStore = yield* SiteStore;
    const record = yield* siteStore.unpublish(site!.record.project, user!, config);
    return {
      project: projectSummary(record, contentBaseUrl(request, config), projectRole(record, user, config), config),
    };
  });
}

/** Handles `POST /api/projects/:project/share` (SiteStore enforces admin). */
function shareProject({ request, user, site, payload }: ApiContext<"project-share">) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const changes = yield* validateShareChanges(payload);
    const siteStore = yield* SiteStore;
    const result = yield* siteStore.share(site!.record.project, user!, changes, config);
    return {
      project: projectSummary(result.record, contentBaseUrl(request, config), projectRole(result.record, user, config), config),
      warnings: result.warnings,
    };
  });
}

/** Handles `DELETE /api/projects/:project` (SiteStore enforces owner). */
function deleteProject({ user, site }: ApiContext<"project-delete">) {
  return Effect.gen(function* () {
    const siteStore = yield* SiteStore;
    yield* siteStore.deleteProject(site!.record.project, user!);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The complete security policy for every contract endpoint. The mapped type
 * is the exhaustiveness proof: a new endpoint added to ScratchworkApi will
 * not compile until it gets a policy here, and a policy for a removed
 * endpoint is a compile error too.
 */
const API_POLICY: { readonly [Name in ScratchworkEndpointName]: ApiPolicy<Name> } = {
  health: { auth: "optional", minimumRole: null, mutation: false, visibility: "status", handler: health },
  "cli-token-exchange": {
    auth: "code-exchange",
    minimumRole: null,
    mutation: true,
    visibility: "session-token",
    payloadLimit: { maxBytes: MAX_CLI_TOKEN_BODY_BYTES, message: "Request body is too large" },
    handler: exchangeCliToken,
  },
  me: { auth: "optional", minimumRole: null, mutation: false, visibility: "identity", handler: me },
  publish: {
    auth: "bearer",
    minimumRole: "write",
    mutation: true,
    visibility: "project-summary",
    payloadLimit: { maxBytes: MAX_PUBLISH_BODY_BYTES, message: "Publish body is too large" },
    handler: publish,
  },
  "projects-list": { auth: "bearer", minimumRole: null, mutation: false, visibility: "own-projects", handler: listProjects },
  resolve: { auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-summary", handler: resolveProjectPath },
  "project-info": { auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-summary", handler: projectInfo },
  "project-bundle": { auth: "bearer", minimumRole: "read", mutation: false, visibility: "project-content", handler: projectBundle },
  "project-unpublish": { auth: "bearer", minimumRole: "admin", mutation: true, visibility: "project-summary", handler: unpublishProject },
  "project-share": {
    auth: "bearer",
    minimumRole: "admin",
    mutation: true,
    visibility: "project-summary",
    payloadLimit: { maxBytes: MAX_SHARE_BODY_BYTES, message: "Share body is too large" },
    handler: shareProject,
  },
  "project-delete": { auth: "bearer", minimumRole: "owner", mutation: true, visibility: "status", handler: deleteProject },
};

/** The registry: every contract endpoint joined with its policy, in contract
 * order. Derived, never hand-listed — the contract is the route inventory. */
const ROUTES: ReadonlyArray<RegisteredRoute> = Object.values(ScratchworkApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => {
    const name = endpoint.name as ScratchworkEndpointName;
    const policy = API_POLICY[name];
    return {
      name,
      method: endpoint.method,
      path: endpoint.path,
      auth: policy.auth,
      minimumRole: policy.minimumRole,
      mutation: policy.mutation,
      visibility: policy.visibility,
      payloadLimit: policy.payloadLimit,
      endpoint: endpoint as unknown as HttpApiEndpoint.HttpApiEndpoint.AnyWithProps,
      handler: policy.handler as unknown as RegisteredRoute["handler"],
    };
  }),
);

/** Every JSON endpoint this server exposes, with its complete policy. */
export const API_ROUTES: ReadonlyArray<ApiRoute> = ROUTES;

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
    const matches = ROUTES
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

/** Applies the declared policy in order — origin, principal, project gate,
 * payload decode — then runs the handler and encodes its result through the
 * endpoint's success schema. */
function runRoute(
  route: RegisteredRoute,
  project: string | null,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, RouteServices> {
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

    const payload = Option.isSome(route.endpoint.payloadSchema) && route.payloadLimit != null
      ? yield* readEndpointPayload(request, route.endpoint.payloadSchema.value, route.payloadLimit)
      : undefined;

    const result = yield* route.handler({ request, url, user, site, payload: payload as never });
    const body = yield* Schema.encodeUnknown(route.endpoint.successSchema as Schema.Schema<unknown, unknown>)(result).pipe(
      Effect.mapError((cause) => new HttpError({ status: 500, message: "Could not encode the response", cause })),
    );
    return jsonResponse(body, 200);
  });
}

/** Reads, size-limits, parses, and strictly decodes one request body through
 * the contract payload schema. Decoding is deliberately strict — every
 * problem is reported and unknown fields are errors — so protocol drift
 * surfaces as a clear 400 instead of being silently dropped. */
function readEndpointPayload(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Schema.Any,
  limit: PayloadLimit,
): Effect.Effect<unknown, HttpError> {
  return Effect.gen(function* () {
    const text = yield* request.text.pipe(
      HttpServerRequest.withMaxBodySize(Option.some(limit.maxBytes)),
      Effect.mapError((cause) => new HttpError({ status: 413, message: limit.message, cause })),
    );
    if (new TextEncoder().encode(text).byteLength > limit.maxBytes) {
      return yield* Effect.fail(new HttpError({ status: 413, message: limit.message }));
    }
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(text).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "Invalid JSON body" })),
    );
    return yield* Schema.decodeUnknown(schema as Schema.Schema<unknown, unknown>)(parsed, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) =>
        new HttpError({ status: 400, message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );
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
