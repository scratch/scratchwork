/**
 * The persisted data model for published sites. Mutable state lives in two PrimitiveDb
 * namespaces — "projects" (project pointer, keyed by the globally unique project name)
 * and "projects-by-owner" (owner listing index) — while immutable data lives in object
 * storage: revision JSON under projects/{project}/revisions/{id}.json and
 * content-addressed blobs under blobs/sha256/{aa}/{hash}. Publishing writes blobs and a
 * new revision, then flips the project pointer; the `ifNoneMatch: "*"` put of a new
 * pointer is the single server-wide claim on the project name.
 */
import * as Schema from "effect/Schema";
import { isSafeSitePath } from "@scratchwork/shared/site/paths";
import { isSafeProjectIdentifier } from "./access.ts";

/** DB namespace of mutable project pointers, keyed by bare project name. */
export const PROJECTS_NAMESPACE = "projects";
/** DB namespace of per-owner project lists, keyed `encodedOwnerId/project`. */
export const OWNER_INDEX_NAMESPACE = "projects-by-owner";

/** Validates a stored owner. The version literals in the schemas below gate format migrations. */
const SiteOwnerSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
});

/** Validates one stored file entry of a revision. */
const SiteFileObjectSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.filter((path) => isSafeSitePath(path) || "Invalid site path")),
  objectKey: Schema.String,
  sha256: Schema.String.pipe(Schema.filter((hash) => /^[0-9a-f]{64}$/.test(hash) || "Invalid SHA-256")),
  size: Schema.Number.pipe(Schema.filter((size) => Number.isInteger(size) && size >= 0 || "Invalid file size")),
  contentType: Schema.String,
});

/** The pointer fields of a stored project record. The three access groups
 * (`readers`, `writers`, `admins`) grade per-account roles — each level implies the ones
 * below, and the owner holds every role. The grant groups default to "private" when
 * absent. */
const siteRecordCommonFields = {
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
  readers: Schema.optionalWith(Schema.String, { default: () => "private" }),
  writers: Schema.optionalWith(Schema.String, { default: () => "private" }),
  admins: Schema.optionalWith(Schema.String, { default: () => "private" }),
  owner: SiteOwnerSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentRevisionId: Schema.String,
  currentOpenPath: Schema.String,
  fileCount: Schema.Number.pipe(Schema.filter((count) => Number.isInteger(count) && count >= 0 || "Invalid file count")),
  totalBytes: Schema.Number.pipe(Schema.filter((bytes) => Number.isInteger(bytes) && bytes >= 0 || "Invalid total bytes")),
} as const;

/** Validates a stored project pointer. `isPublic` is the public/private toggle;
 * `commentsEnabled` turns on viewer comments (never together with `isPublic` —
 * the store rejects the combination at publish time). The optionalWith default
 * keeps pre-comments records readable without a version bump. */
const SiteRecordSchema = Schema.Struct({
  version: Schema.Literal(5),
  isPublic: Schema.Boolean,
  commentsEnabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  ...siteRecordCommonFields,
});

/** Validates a stored owner-index entry. */
const OwnerProjectRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
});

/** Validates a stored immutable revision document. */
const SiteRevisionRecordSchema = Schema.Struct({
  version: Schema.Literal(3),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
  revisionId: Schema.String,
  createdAt: Schema.String,
  openPath: Schema.String,
  files: Schema.Array(SiteFileObjectSchema),
}).pipe(
  Schema.filter((revision) => uniquePaths(revision.files) || "Duplicate revision paths"),
);

export {
  OwnerProjectRecordSchema,
  SiteRecordSchema,
  SiteRevisionRecordSchema,
};

/** A project's owner as recorded at publish time. */
export type SiteOwner = typeof SiteOwnerSchema.Type;
/** One published file: its site path and content-addressed blob location. */
export type SiteFileObject = typeof SiteFileObjectSchema.Type;
/** The mutable project pointer: current revision, public toggle, and owner metadata. */
export type SiteRecord = typeof SiteRecordSchema.Type;
/** Owner-index entry naming one project the owner has published. */
export type OwnerProjectRecord = typeof OwnerProjectRecordSchema.Type;
/** An immutable published revision: the file list for one publish. */
export type SiteRevisionRecord = typeof SiteRevisionRecordSchema.Type;

/** Builds the object-storage key of one immutable revision JSON document. */
export function revisionRecordKey(project: string, revisionId: string): string {
  return `projects/${project}/revisions/${revisionId}.json`;
}

/** Builds the content-addressed object key for a file blob, sharded by hash prefix. */
export function blobObjectKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Builds the owner-index key for one project. */
export function ownerIndexKey(owner: SiteOwner, project: string): string {
  return `${encodeKeySegment(owner.id)}/${project}`;
}

/** Builds the owner-index key prefix that lists every project of one owner. */
export function ownerIndexPrefix(ownerId: string): string {
  return `${encodeKeySegment(ownerId)}/`;
}

/** Percent-encodes an owner-index key segment, additionally escaping "." (which
 * encodeURIComponent leaves bare) so an owner id can never form a "." or ".." segment. */
function encodeKeySegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

/** Returns true when every file path in the list is unique. */
function uniquePaths(files: ReadonlyArray<{ readonly path: string }>): boolean {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) return false;
    paths.add(file.path);
  }
  return true;
}
