/**
 * The content-origin comments API: the per-project routes the injected comments
 * widget calls, served under `/:project/__scratchwork/comments` on the content
 * host. These routes are deliberately NOT part of the shared CLI contract —
 * the CLI never calls them — but they follow the same route-policy discipline
 * as the app-host JSON API (AGENTS.md, invariant 4): every route is registered
 * once in COMMENTS_ROUTES with its method, minimum project role, and mutation
 * flag; dispatch walks only that registry; and the policy matrix test
 * enumerates it. The gates run in fixed order for every route:
 *
 *  - the whole `__scratchwork/` prefix under a project is server-owned
 *    (publishing files into it is rejected), and everything under it that is
 *    not a registered comments route is 404;
 *  - a missing project, a public project, and a comments-disabled project all
 *    read as the same 404, so these routes reveal nothing servePublishedSite
 *    would not;
 *  - every request rejects cross-origin browser calls against the content
 *    origin, and subresource requests must prove (via the script-unforgeable
 *    Referer, exactly like private-content serving) that the initiating page
 *    lives inside this project;
 *  - the caller authenticates with the project's path-scoped access cookie —
 *    the same credential that gated the page itself — which names the viewer
 *    and is re-checked against current read access on every request;
 *  - request bodies are size-capped and decoded strictly through the wire
 *    schemas below; responses are encoded through their declared schemas.
 *
 * Comments exist only on private projects (publish rejects comments+public),
 * so every commenter is an authenticated, read-authorized viewer. Fine-grained
 * rules on top of the "read" floor: anyone with read access may comment and
 * resolve/unresolve; only the comment's author or a project writer+ may edit
 * or delete it.
 *
 * Trust model note: these routes are same-origin with the project's own pages,
 * so a project's published JavaScript can act on its viewers' behalf — but
 * only inside that project's comment space (the cookie and the guards scope
 * everything to the one project the viewer is already reading, whose authors
 * they already trust). No other project's comments, content, or identity is
 * reachable.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HtmlTransform } from "@scratchwork/shared/site/html";
import { readEndpointPayload } from "./api-routes.ts";
import { Auth, type AuthUser } from "./auth.ts";
import {
  CommentAnchorSchema,
  CommentRecordSchema,
  MAX_COMMENT_BODY_CHARS,
  normalizeCommentPage,
  type CommentRecord,
} from "./comment-records.ts";
import {
  createComment,
  deleteComment,
  listPageComments,
  loadComment,
  putComment,
  type CommentStoreError,
} from "./comment-store.ts";
import { COMMENTS_WIDGET_JS } from "./comments-widget.generated.ts";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { PrimitiveDb, type PrimitiveDbShape } from "./db.ts";
import {
  contentBaseUrl,
  HttpError,
  jsonResponse,
  rejectCrossOriginApiRequest,
  requestHomepageOrigin,
  securityHeaders,
} from "./http.ts";
import { blockedCrossProjectSubresource, projectAccessUser } from "./project-access.ts";
import { RESERVED_SITE_PREFIX } from "./publish-request.ts";
import { projectForRequest, routeRest } from "./routes.ts";
import { projectRole, roleAtLeast, SiteStore, type LoadedSite, type ProjectRole } from "./site-store.ts";
import { randomCommentId } from "./tokens.ts";
import type { AuthError } from "./auth.ts";
import type { SiteStoreError } from "./site-store.ts";
import type { StorageError } from "./storage.ts";

/** The path under a project where every comments route lives. */
const COMMENTS_REST_PREFIX = `/${RESERVED_SITE_PREFIX}/comments`;
/** Generous ceiling for comment request bodies: one capped body plus anchors. */
const MAX_COMMENTS_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/** One comment as the widget sees it: the stored record minus its internal
 * `version`/`project` fields. */
const CommentWireSchema = Schema.Struct({
  id: Schema.String,
  page: Schema.String,
  author: Schema.Struct({ email: Schema.String }),
  body: Schema.String,
  anchors: Schema.Array(CommentAnchorSchema),
  resolved: Schema.Boolean,
  resolvedBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

/** What the list endpoint tells the widget about the viewer themselves:
 * identity for authorship display, and whether they hold write access (may
 * edit/delete everyone's comments). The role never appears in the page DOM. */
const CommentsViewerSchema = Schema.Struct({
  email: Schema.String,
  canModerate: Schema.Boolean,
});

const CommentsListResponseSchema = Schema.Struct({
  viewer: CommentsViewerSchema,
  comments: Schema.Array(CommentWireSchema),
});

const CommentResponseSchema = Schema.Struct({
  viewer: CommentsViewerSchema,
  comment: CommentWireSchema,
});

const CommentDeleteResponseSchema = Schema.Struct({ ok: Schema.Boolean });

/** The JSON body of a comment create: which page, the text, and the anchor
 * candidates (most specific first, body-relative fallback last). */
const CommentCreateRequestSchema = Schema.Struct({
  page: Schema.String,
  body: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Comment body must not be empty" }),
    Schema.maxLength(MAX_COMMENT_BODY_CHARS, { message: () => "Comment body is too long" }),
  ),
  anchors: Schema.Array(CommentAnchorSchema).pipe(Schema.minItems(1), Schema.maxItems(8)),
});

/** The JSON body of a comment update: a body edit, a resolved flip, or both. */
const CommentUpdateRequestSchema = Schema.Struct({
  page: Schema.String,
  body: Schema.optional(Schema.String.pipe(
    Schema.minLength(1, { message: () => "Comment body must not be empty" }),
    Schema.maxLength(MAX_COMMENT_BODY_CHARS, { message: () => "Comment body is too long" }),
  )),
  resolved: Schema.optional(Schema.Boolean),
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Failures any comments handler may raise. */
type CommentsRouteError = HttpError | AuthError | CommentStoreError | SiteStoreError | StorageError;

/** What the policy gates hand every comments handler: the request, the loaded
 * (private, comments-enabled) site, the cookie-authenticated viewer with their
 * resolved role, the `:id` path segment for item routes, and the DB. */
interface CommentsContext {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly site: LoadedSite;
  readonly user: AuthUser;
  readonly role: ProjectRole;
  readonly id: string | null;
  readonly db: PrimitiveDbShape;
}

/** One registered comments route: subject shape, method, and policy. All
 * routes require "read" (the cookie gate); rules above read are enforced by
 * the handler and declared via `ownerOrWriter` so the matrix can assert them. */
interface CommentsRoute {
  readonly name: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** "collection" matches .../comments, "item" matches .../comments/{id},
   * "widget" matches .../comments/widget.js. */
  readonly subject: "collection" | "item" | "widget";
  readonly mutation: boolean;
  /** True when the route additionally requires being the comment's author or
   * holding write access. */
  readonly ownerOrWriter: boolean;
  readonly handler: (
    context: CommentsContext,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, CommentsRouteError>;
}

/** Every comments route, with its complete policy. The dispatcher walks only
 * this list, and the comments policy matrix test enumerates it. */
export const COMMENTS_ROUTES: ReadonlyArray<CommentsRoute> = [
  { name: "comments-widget", method: "GET", subject: "widget", mutation: false, ownerOrWriter: false, handler: serveWidget },
  { name: "comments-list", method: "GET", subject: "collection", mutation: false, ownerOrWriter: false, handler: listComments },
  { name: "comments-create", method: "POST", subject: "collection", mutation: true, ownerOrWriter: false, handler: postComment },
  { name: "comments-update", method: "PATCH", subject: "item", mutation: true, ownerOrWriter: true, handler: patchComment },
  { name: "comments-delete", method: "DELETE", subject: "item", mutation: true, ownerOrWriter: true, handler: removeComment },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes one request through the comments registry, or returns null when the
 * path is not a `/:project/__scratchwork/...` content-host path. Runs before
 * the app's GET/HEAD method gate so mutations reach it. Anything under the
 * reserved prefix that matches no registered route is 404 — the prefix is
 * server-owned in its entirety.
 */
export function dispatchCommentsRoute(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse | null,
  CommentsRouteError,
  ServerConfig | SiteStore | Auth | PrimitiveDb
> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    // On a home origin the whole path space belongs to the homepage project;
    // comments are a content-origin feature.
    if (requestHomepageOrigin(request, config) != null) return null;
    const project = projectForRequest(url.pathname);
    if (project == null) return null;
    const rest = routeRest(url.pathname, project);
    if (rest == null) return null;
    if (rest !== `/${RESERVED_SITE_PREFIX}` && !rest.startsWith(`/${RESERVED_SITE_PREFIX}/`)) return null;

    const subject = matchSubject(rest);
    if (subject == null) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    const siteStore = yield* SiteStore;
    const site = yield* siteStore.loadProject(project);
    // Missing, public, and comments-disabled all answer identically so these
    // routes never confirm which projects exist or how they are configured.
    if (site == null || site.record.isPublic || !site.record.commentsEnabled) {
      return yield* Effect.fail(new HttpError({ status: 404, message: "Not found" }));
    }

    // HEAD is answered by the matching GET route, per HTTP semantics.
    const method = request.method === "HEAD" ? "GET" : request.method;
    const candidates = COMMENTS_ROUTES.filter((route) => route.subject === subject.kind);
    const route = candidates.find((candidate) => candidate.method === method);
    if (route == null) {
      return yield* Effect.fail(new HttpError({
        status: candidates.length === 0 ? 404 : 405,
        message: candidates.length === 0 ? "Not found" : "Method not allowed",
      }));
    }

    return yield* runCommentsRoute(route, subject.id, request, url, site, config);
  });
}

/** Applies the shared policy gates in fixed order, then runs the handler. */
function runCommentsRoute(
  route: CommentsRoute,
  id: string | null,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  site: LoadedSite,
  config: ServerConfigShape,
): Effect.Effect<HttpServerResponse.HttpServerResponse, CommentsRouteError, Auth | PrimitiveDb> {
  return Effect.gen(function* () {
    yield* rejectCrossOriginApiRequest(request, contentBaseUrl(request, config));
    if (blockedCrossProjectSubresource(request, site.record.project)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Cross-project request rejected" }));
    }

    const auth = yield* Auth;
    const user = yield* projectAccessUser(request, auth, site, config);
    if (user == null) {
      return yield* Effect.fail(new HttpError({ status: 401, message: "Authentication required" }));
    }
    const role = projectRole(site.record, user, config);

    const db = yield* PrimitiveDb;
    return yield* route.handler({ request, url, site, user, role, id, db });
  });
}

/** Matches the path remainder under the project against the three route
 * subjects. Item ids are comment ids (safe id alphabet); anything else under
 * the reserved prefix is no subject at all, which dispatch answers with 404. */
function matchSubject(rest: string): { readonly kind: CommentsRoute["subject"]; readonly id: string | null } | null {
  if (rest === COMMENTS_REST_PREFIX) return { kind: "collection", id: null };
  if (rest === `${COMMENTS_REST_PREFIX}/widget.js`) return { kind: "widget", id: null };
  const item = new RegExp(`^${COMMENTS_REST_PREFIX}/([0-9]{14}-[a-z2-9]{8})$`).exec(rest);
  if (item != null) return { kind: "item", id: item[1] };
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Handles `GET .../comments/widget.js`: the self-contained comments UI script
 * injected into every HTML page of a comments-enabled project. */
function serveWidget(_context: CommentsContext): Effect.Effect<HttpServerResponse.HttpServerResponse, never> {
  return Effect.succeed(HttpServerResponse.text(COMMENTS_WIDGET_JS, {
    contentType: "text/javascript; charset=utf-8",
    headers: securityHeaders(),
  }));
}

/** Handles `GET .../comments?page=`: every comment on one page, oldest first,
 * plus the viewer's own identity and moderation standing. */
function listComments({ url, site, user, role, db }: CommentsContext) {
  return Effect.gen(function* () {
    const page = yield* requirePage(url.searchParams.get("page"));
    const comments = yield* listPageComments(db, site.record.project, page);
    return yield* encodeResponse(CommentsListResponseSchema, {
      viewer: viewerInfo(user, role),
      comments: comments.map(wireComment),
    });
  });
}

/** Handles `POST .../comments`: creates a comment authored by the viewer. */
function postComment({ request, site, user, role, db }: CommentsContext) {
  return Effect.gen(function* () {
    const payload = yield* readEndpointPayload(request, CommentCreateRequestSchema, {
      maxBytes: MAX_COMMENTS_BODY_BYTES,
      message: "Comment is too large",
    }).pipe(Effect.map((value) => value as typeof CommentCreateRequestSchema.Type));
    const page = yield* requirePage(payload.page);
    const now = new Date().toISOString();
    const record: CommentRecord = {
      version: 1,
      id: randomCommentId(),
      project: site.record.project,
      page,
      author: { email: user.email },
      body: payload.body,
      anchors: payload.anchors,
      resolved: false,
      createdAt: now,
      updatedAt: now,
    };
    const written = yield* createComment(db, yield* validateRecord(record));
    return yield* encodeResponse(CommentResponseSchema, {
      viewer: viewerInfo(user, role),
      comment: wireComment(written),
    });
  });
}

/** Handles `PATCH .../comments/:id`: edits the body (author or writer+ only)
 * and/or flips resolved (any reader, matching the Google Docs convention —
 * resolving is triage, not authorship). */
function patchComment({ request, site, user, role, id, db }: CommentsContext) {
  return Effect.gen(function* () {
    const payload = yield* readEndpointPayload(request, CommentUpdateRequestSchema, {
      maxBytes: MAX_COMMENTS_BODY_BYTES,
      message: "Comment is too large",
    }).pipe(Effect.map((value) => value as typeof CommentUpdateRequestSchema.Type));
    if (payload.body == null && payload.resolved == null) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Nothing to update" }));
    }
    const page = yield* requirePage(payload.page);
    const loaded = yield* requireComment(db, site.record.project, page, id!);
    if (payload.body != null && !mayModify(loaded.value, user, role)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Only the comment author or a project writer can edit a comment" }));
    }

    const resolvedChanged = payload.resolved != null && payload.resolved !== loaded.value.resolved;
    const next: CommentRecord = {
      ...loaded.value,
      body: payload.body ?? loaded.value.body,
      resolved: payload.resolved ?? loaded.value.resolved,
      ...(resolvedChanged
        ? payload.resolved
          ? { resolvedBy: user.email }
          : { resolvedBy: undefined }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const written = yield* putComment(db, yield* validateRecord(next), loaded.version);
    return yield* encodeResponse(CommentResponseSchema, {
      viewer: viewerInfo(user, role),
      comment: wireComment(written),
    });
  });
}

/** Handles `DELETE .../comments/:id?page=`: author or writer+ only. */
function removeComment({ url, site, user, role, id, db }: CommentsContext) {
  return Effect.gen(function* () {
    const page = yield* requirePage(url.searchParams.get("page"));
    const loaded = yield* requireComment(db, site.record.project, page, id!);
    if (!mayModify(loaded.value, user, role)) {
      return yield* Effect.fail(new HttpError({ status: 403, message: "Only the comment author or a project writer can delete a comment" }));
    }
    yield* deleteComment(db, site.record.project, page, id!);
    return yield* encodeResponse(CommentDeleteResponseSchema, { ok: true });
  });
}

// ---------------------------------------------------------------------------
// Shared handler helpers
// ---------------------------------------------------------------------------

/** True when the viewer may edit or delete this comment: its author, or
 * anyone holding write access to the project. */
function mayModify(comment: CommentRecord, user: AuthUser, role: ProjectRole): boolean {
  return comment.author.email.toLowerCase() === user.email.toLowerCase() || roleAtLeast(role, "write");
}

/** The viewer block included in every non-delete response. */
function viewerInfo(user: AuthUser, role: ProjectRole): typeof CommentsViewerSchema.Type {
  return { email: user.email, canModerate: roleAtLeast(role, "write") };
}

/** Normalizes a viewer-supplied page path or fails 400. */
function requirePage(value: string | null): Effect.Effect<string, HttpError> {
  const page = value == null ? null : normalizeCommentPage(value);
  return page == null
    ? Effect.fail(new HttpError({ status: 400, message: "Invalid page path" }))
    : Effect.succeed(page);
}

/** Loads one comment or fails 404. */
function requireComment(db: PrimitiveDbShape, project: string, page: string, id: string) {
  return loadComment(db, project, page, id).pipe(
    Effect.flatMap((loaded) =>
      loaded == null
        ? Effect.fail(new HttpError({ status: 404, message: "Comment not found" }))
        : Effect.succeed(loaded),
    ),
  );
}

/** Validates a record the handler assembled — the runtime counterpart of the
 * schema the store trusts, so caps hold even for handler-constructed values. */
function validateRecord(record: CommentRecord): Effect.Effect<CommentRecord, HttpError> {
  return Schema.decodeUnknown(CommentRecordSchema)(record, { errors: "all" }).pipe(
    Effect.mapError(() => new HttpError({ status: 400, message: "Invalid comment" })),
  );
}

/** Strips a stored comment down to its wire shape. */
function wireComment(record: CommentRecord): typeof CommentWireSchema.Type {
  return {
    id: record.id,
    page: record.page,
    author: record.author,
    body: record.body,
    anchors: record.anchors,
    resolved: record.resolved,
    ...(record.resolvedBy != null ? { resolvedBy: record.resolvedBy } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Encodes a handler result through its declared response schema — a response
 * that drifts from the schema is a 500, exactly like the app-host API. */
function encodeResponse<A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpError> {
  return Schema.encode(schema)(value).pipe(
    Effect.mapError((cause) => new HttpError({ status: 500, message: "Could not encode the response", cause })),
    Effect.map((body) => jsonResponse(body, 200)),
  );
}

// ---------------------------------------------------------------------------
// Widget injection
// ---------------------------------------------------------------------------

/** Returns the HTML transform that injects the comments widget script into a
 * comments-enabled project's pages, mirroring the dev server's live-reload
 * injector: before </body> when present, appended otherwise. */
export function injectCommentsWidget(pathPrefix: string): HtmlTransform {
  const tag = `<script src="${pathPrefix}${COMMENTS_REST_PREFIX}/widget.js" defer></script>`;
  return (html) => {
    const index = html.toLowerCase().lastIndexOf("</body>");
    if (index === -1) return Effect.succeed(`${html}\n${tag}\n`);
    return Effect.succeed(`${html.slice(0, index)}${tag}\n${html.slice(index)}`);
  };
}
