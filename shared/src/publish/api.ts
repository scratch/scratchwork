/*
 * The CLI↔server JSON API contract, defined once as an `@effect/platform`
 * `HttpApi` (ScratchworkApi, at the bottom of this file). Every JSON endpoint
 * is declared here with its method, path, request payload, and success
 * schema; the CLI derives its HTTP client from the contract object
 * (cli/src/api.ts) and the server derives its route registry, request
 * decoding, and response encoding from the same object
 * (server/core/src/api-routes.ts) — so the two sides cannot drift.
 *
 * Decoding conventions: the server decodes request payloads strictly
 * (errors: "all", onExcessProperty: "error") so protocol drift surfaces as a
 * clear 400, while the CLI decodes responses with the default (tolerant)
 * options so a newer server adding fields never breaks an older CLI.
 */
import * as HttpApi from "@effect/platform/HttpApi";
import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint";
import * as HttpApiGroup from "@effect/platform/HttpApiGroup";
import * as HttpApiSchema from "@effect/platform/HttpApiSchema";
import * as Schema from "effect/Schema";
import { isSafeProjectIdentifier } from "../site/identifiers.ts";
import { PublishBundleSchema } from "./bundle.ts";

export { PublishBundleSchema };

/** A safe project identifier, as validated everywhere a project name crosses
 * the wire (publish bodies and `/api/projects/:project` path segments). */
export const ProjectIdentifierSchema = Schema.String.pipe(
  Schema.filter((project) => isSafeProjectIdentifier(project) || "Invalid project"),
);

/** The JSON body of `POST /api/publish`. `project` is optional at the protocol
 * level — a random-naming server mints a name when none is sent; `isPublic` is
 * the public/private toggle (omitted preserves an existing project's setting,
 * and a new project is created private). Per-account and per-domain access is a
 * separate grant list managed through the share API, not a publish-time setting. */
export const PublishRequestBodySchema = Schema.Struct({
  bundle: PublishBundleSchema,
  openPath: Schema.optional(Schema.String),
  project: Schema.optional(ProjectIdentifierSchema),
  isPublic: Schema.optional(Schema.Boolean),
});

/** The publish request body as the CLI builds it and the server decodes it. */
export type PublishRequestBody = typeof PublishRequestBodySchema.Type;

/** The server's response to a successful publish. `project` is authoritative:
 * on a random-naming server it is how the CLI learns the assigned name. */
export const PublishResponseSchema = Schema.Struct({
  project: Schema.String,
  isPublic: Schema.Boolean,
  openPath: Schema.String,
  url: Schema.String,
});

/** The decoded publish response. */
export type PublishResponse = typeof PublishResponseSchema.Type;

/** Path of the CLI login-code exchange endpoint. The browser leg of a CLI login
 * delivers a short-lived one-time authorization code to the CLI's loopback
 * callback; the CLI then POSTs it here (a back-channel request, no redirect)
 * together with its PKCE verifier to receive the bearer token. */
export const CLI_TOKEN_EXCHANGE_PATH = "/auth/cli/token";

/** The JSON body of `POST /auth/cli/token`: the authorization code from the
 * loopback callback, the PKCE S256 verifier whose challenge the code was bound
 * to, and the exact loopback redirect URI the code was delivered to. */
export const CliTokenRequestSchema = Schema.Struct({
  code: Schema.String,
  codeVerifier: Schema.String,
  redirectUri: Schema.String,
});

/** The decoded CLI token-exchange request. */
export type CliTokenRequest = typeof CliTokenRequestSchema.Type;

/** The server's response to a successful CLI code exchange: the bearer token,
 * the canonical server origin to store it under, and — on Cloudflare Access
 * servers — the relayed Access JWT the CLI presents to pass the edge. */
export const CliTokenResponseSchema = Schema.Struct({
  token: Schema.String,
  server: Schema.String,
  email: Schema.String,
  cfToken: Schema.optional(Schema.String),
});

/** The decoded CLI token-exchange response. */
export type CliTokenResponse = typeof CliTokenResponseSchema.Type;

/** The error envelope every non-2xx JSON API response carries. Decoded
 * tolerantly on purpose: extra fields from a newer server are ignored. */
export const ApiErrorBodySchema = Schema.Struct({ error: Schema.String });

/** The decoded error envelope. */
export type ApiErrorBody = typeof ApiErrorBodySchema.Type;

/** A project's per-role grant lists (emails and @domain groups). */
export const ProjectPermissionsSchema = Schema.Struct({
  read: Schema.Array(Schema.String),
  write: Schema.Array(Schema.String),
  admin: Schema.Array(Schema.String),
});

/** The decoded per-role grant lists. */
export type ProjectPermissions = typeof ProjectPermissionsSchema.Type;

/** One project summary as the API reports it (see the server's projectSummary).
 * `permissions` names other users' emails, so the server includes it only for
 * admin+ callers; `url` is optional so older servers stay readable. */
export const ProjectInfoSchema = Schema.Struct({
  project: Schema.String,
  isPublic: Schema.Boolean,
  permissions: Schema.optional(ProjectPermissionsSchema),
  url: Schema.optional(Schema.String),
  owner: Schema.Struct({ id: Schema.String, email: Schema.String }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentOpenPath: Schema.String,
  fileCount: Schema.Number,
  totalBytes: Schema.Number,
});

/** The decoded project summary. */
export type ProjectInfo = typeof ProjectInfoSchema.Type;

/** The single-project envelope returned by the info, resolve, and unpublish APIs. */
export const ProjectResponseSchema = Schema.Struct({
  project: ProjectInfoSchema,
});

/** The decoded single-project envelope. */
export type ProjectResponse = typeof ProjectResponseSchema.Type;

/** The envelope returned by `GET /api/projects`. */
export const ProjectsListResponseSchema = Schema.Struct({
  projects: Schema.Array(ProjectInfoSchema),
});

/** The decoded projects-list envelope. */
export type ProjectsListResponse = typeof ProjectsListResponseSchema.Type;

/** The envelope returned by the share API: the updated project plus advisory
 * warnings (revokes that leave the account with access anyway). */
export const ShareResponseSchema = Schema.Struct({
  project: ProjectInfoSchema,
  warnings: Schema.Array(Schema.String),
});

/** The decoded share envelope. */
export type ShareResponse = typeof ShareResponseSchema.Type;

/** One share target: an email address or an @domain group. Target grammar and
 * sharing policy are enforced server-side so every access rule lives in one
 * place; the wire contract only rejects blank strings. */
const ShareTargetSchema = Schema.String.pipe(
  Schema.filter((value) => value.trim() !== "" || "Share targets must be non-empty"),
);

/** The JSON body of `POST /api/projects/:project/share`: grant `add` targets
 * the given role (default read), and strip every role from `remove` targets. */
export const ShareRequestSchema = Schema.Struct({
  role: Schema.optional(Schema.Literal("read", "write", "admin")),
  add: Schema.optional(Schema.Array(ShareTargetSchema)),
  remove: Schema.optional(Schema.Array(ShareTargetSchema)),
});

/** The decoded share request body. */
export type ShareRequest = typeof ShareRequestSchema.Type;

/** The response of `GET /api/me`: the caller's own authentication state.
 * Mirrors the server's AuthUser, including the optional profile fields. */
export const MeResponseSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  user: Schema.NullOr(Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    name: Schema.optional(Schema.String),
    picture: Schema.optional(Schema.String),
  })),
});

/** The decoded identity echo. */
export type MeResponse = typeof MeResponseSchema.Type;

/** The bare acknowledgment returned by `GET /health` and the delete API. */
export const OkResponseSchema = Schema.Struct({ ok: Schema.Boolean });

/** The decoded acknowledgment. */
export type OkResponse = typeof OkResponseSchema.Type;

/** The envelope returned by `GET /api/projects/:project/bundle` (clone). */
export const ProjectBundleResponseSchema = Schema.Struct({
  bundle: PublishBundleSchema,
});

/** The decoded bundle envelope. */
export type ProjectBundleResponse = typeof ProjectBundleResponseSchema.Type;

// ---------------------------------------------------------------------------
// The contract object
// ---------------------------------------------------------------------------

/** The `:project` path parameter of the per-project endpoints. */
const projectParam = HttpApiSchema.param("project", ProjectIdentifierSchema);

/**
 * Every JSON endpoint of the scratchwork server, in one top-level group.
 * Endpoint names double as the server's route-policy registry keys
 * (invariant 4), so each name here must have a policy entry there — the
 * registry's mapped type enforces it at compile time.
 *
 * The contract deliberately declares no error schemas: every non-2xx response
 * carries the ApiErrorBodySchema envelope regardless of status, and the CLI
 * reads it from the raw response so unknown statuses degrade gracefully.
 */
const CliApiGroup = HttpApiGroup.make("cli", { topLevel: true })
  .add(HttpApiEndpoint.get("health", "/health").addSuccess(OkResponseSchema))
  .add(
    HttpApiEndpoint.post("cli-token-exchange", CLI_TOKEN_EXCHANGE_PATH)
      .setPayload(CliTokenRequestSchema)
      .addSuccess(CliTokenResponseSchema),
  )
  .add(HttpApiEndpoint.get("me", "/api/me").addSuccess(MeResponseSchema))
  .add(
    HttpApiEndpoint.post("publish", "/api/publish")
      .setPayload(PublishRequestBodySchema)
      .addSuccess(PublishResponseSchema),
  )
  .add(HttpApiEndpoint.get("projects-list", "/api/projects").addSuccess(ProjectsListResponseSchema))
  .add(
    HttpApiEndpoint.get("resolve", "/api/resolve")
      .setUrlParams(Schema.Struct({ path: Schema.String }))
      .addSuccess(ProjectResponseSchema),
  )
  .add(HttpApiEndpoint.get("project-info")`/api/projects/${projectParam}`.addSuccess(ProjectResponseSchema))
  .add(HttpApiEndpoint.get("project-bundle")`/api/projects/${projectParam}/bundle`.addSuccess(ProjectBundleResponseSchema))
  .add(HttpApiEndpoint.post("project-unpublish")`/api/projects/${projectParam}/unpublish`.addSuccess(ProjectResponseSchema))
  .add(
    HttpApiEndpoint.post("project-share")`/api/projects/${projectParam}/share`
      .setPayload(ShareRequestSchema)
      .addSuccess(ShareResponseSchema),
  )
  .add(HttpApiEndpoint.del("project-delete")`/api/projects/${projectParam}`.addSuccess(OkResponseSchema));

/** The CLI↔server JSON API contract: the one object both sides derive from. */
export const ScratchworkApi = HttpApi.make("scratchwork").add(CliApiGroup);

/** Union of the contract's endpoint definitions (for type-level derivation). */
export type ScratchworkApiEndpoints = HttpApiGroup.HttpApiGroup.Endpoints<typeof CliApiGroup>;

/** Union of the contract's endpoint names — the server's registry keys. */
export type ScratchworkEndpointName = HttpApiEndpoint.HttpApiEndpoint.Name<ScratchworkApiEndpoints>;

/** The contract endpoint named `Name`. */
export type ScratchworkEndpoint<Name extends ScratchworkEndpointName> = HttpApiEndpoint.HttpApiEndpoint.WithName<
  ScratchworkApiEndpoints,
  Name
>;

/** The declared success (response) type of the endpoint named `Name`. */
export type EndpointSuccess<Name extends ScratchworkEndpointName> = HttpApiEndpoint.HttpApiEndpoint.Success<
  ScratchworkEndpoint<Name>
>;

/** The declared request payload type of the endpoint named `Name` (`never`
 * for endpoints without a body). */
export type EndpointPayload<Name extends ScratchworkEndpointName> = HttpApiEndpoint.HttpApiEndpoint.Payload<
  ScratchworkEndpoint<Name>
>;
