/**
 * The persisted data model for published sites. Mutable state lives in three PrimitiveDb
 * namespaces — "projects" (project pointer, keyed workspace/project), "routes" (route-path
 * index), and "projects-by-owner" (owner listing index) — while immutable data lives in
 * object storage: revision JSON under projects/{ws}/{project}/revisions/{id}.json and
 * content-addressed blobs under blobs/sha256/{aa}/{hash}. Publishing writes blobs and a
 * new revision, then flips the project pointer.
 */
import * as Schema from "effect/Schema";
import { isHex } from "../../../shared/src/encoding/hex";
import { isSafeSitePath } from "../../../shared/src/site/paths";
import { isSafeProjectIdentifier } from "./access";
import { safeRoutePath } from "./routes";

/** DB namespace of mutable project pointers, keyed `workspace/project`. */
export const PROJECTS_NAMESPACE = "projects";
/** DB namespace mapping route paths to their project, keyed by route path. */
export const ROUTES_NAMESPACE = "routes";
/** DB namespace of per-owner project lists, keyed `encodedOwnerId/workspace/project`. */
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
  sha256: Schema.String.pipe(Schema.filter((hash) => hash.length === 64 && isHex(hash) || "Invalid SHA-256")),
  size: Schema.Number.pipe(Schema.filter((size) => Number.isInteger(size) && size >= 0 || "Invalid file size")),
  contentType: Schema.String,
});

/** Validates a stored project pointer. */
const SiteRecordSchema = Schema.Struct({
  version: Schema.Literal(3),
  workspace: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
  routePath: Schema.String.pipe(Schema.filter((value) => safeRoutePath(value) || "Invalid route path")),
  visibility: Schema.String,
  owner: SiteOwnerSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentRevisionId: Schema.String,
  currentOpenPath: Schema.String,
  fileCount: Schema.Number.pipe(Schema.filter((count) => Number.isInteger(count) && count >= 0 || "Invalid file count")),
  totalBytes: Schema.Number.pipe(Schema.filter((bytes) => Number.isInteger(bytes) && bytes >= 0 || "Invalid total bytes")),
});

/** Validates a stored route-index entry. */
const RouteRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  routePath: Schema.String.pipe(Schema.filter((value) => safeRoutePath(value) || "Invalid route path")),
  workspace: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
});

/** Validates a stored owner-index entry. */
const OwnerProjectRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  workspace: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
});

/** Validates a stored immutable revision document. */
const SiteRevisionRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  workspace: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid workspace")),
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
  RouteRecordSchema,
  SiteRecordSchema,
  SiteRevisionRecordSchema,
};

/** A project's owner as recorded at publish time. */
export type SiteOwner = typeof SiteOwnerSchema.Type;
/** One published file: its site path and content-addressed blob location. */
export type SiteFileObject = typeof SiteFileObjectSchema.Type;
/** The mutable project pointer: current revision, route, visibility, and owner metadata. */
export type SiteRecord = typeof SiteRecordSchema.Type;
/** Route-index entry mapping a route path to its project. */
export type RouteRecord = typeof RouteRecordSchema.Type;
/** Owner-index entry naming one project the owner has published. */
export type OwnerProjectRecord = typeof OwnerProjectRecordSchema.Type;
/** An immutable published revision: the file list for one publish. */
export type SiteRevisionRecord = typeof SiteRevisionRecordSchema.Type;

/** Builds the stable project key used by API paths and DB records. */
export function projectKey(workspace: string, project: string): string {
  return `${workspace}/${project}`;
}

/** Builds the object-storage key of one immutable revision JSON document. */
export function revisionRecordKey(workspace: string, project: string, revisionId: string): string {
  return `projects/${workspace}/${project}/revisions/${revisionId}.json`;
}

/** Builds the content-addressed object key for a file blob, sharded by hash prefix. */
export function blobObjectKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Builds the owner-index key for one project. */
export function ownerIndexKey(owner: SiteOwner, workspace: string, project: string): string {
  return `${encodeKeySegment(owner.id)}/${workspace}/${project}`;
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
