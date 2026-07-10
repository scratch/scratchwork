/*
 * The CLI↔server JSON API contract, as Effect Schemas. Both sides derive
 * their types and decoding from these definitions: the server decodes the
 * publish request strictly (errors: "all", onExcessProperty: "error") and
 * types its responses with the exported types so drift is caught at compile
 * time, while the CLI decodes responses with the default (tolerant) options
 * so a newer server adding fields never breaks an older CLI.
 */
import * as Schema from "effect/Schema";
import { decodedBase64ByteLength } from "../encoding/base64";
import { isSafeProjectIdentifier } from "../site/identifiers";
import { isSafeSitePath } from "../site/paths";
import { PUBLISH_BUNDLE_VERSION } from "./bundle";

/** One file in a publish bundle: a safe site-relative path plus base64 content. */
const PublishBundleFileSchema = Schema.Struct({
  path: Schema.String.pipe(
    Schema.filter((path) => isSafeSitePath(path) || "Invalid site path"),
  ),
  contentBase64: Schema.String.pipe(
    Schema.filter((content) => decodedBase64ByteLength(content) != null || "Invalid base64 content"),
  ),
});

/** A complete publish upload: format version plus every file in the site.
 * The runtime shape matches PublishBundle in bundle.ts. */
export const PublishBundleSchema = Schema.Struct({
  version: Schema.Literal(PUBLISH_BUNDLE_VERSION),
  files: Schema.Array(PublishBundleFileSchema),
});

/** The JSON body of `POST /api/publish`. `project` is optional at the protocol
 * level — a random-naming server mints a name when none is sent; `isPublic` is
 * the public/private toggle (omitted preserves an existing project's setting,
 * and a new project is created private). Per-account and per-domain access is a
 * separate grant list managed through the share API, not a publish-time setting. */
export const PublishRequestBodySchema = Schema.Struct({
  bundle: PublishBundleSchema,
  openPath: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String.pipe(Schema.filter((project) => isSafeProjectIdentifier(project) || "Invalid project"))),
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
