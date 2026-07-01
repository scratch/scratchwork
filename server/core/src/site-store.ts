import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { base64ToBytes, bytesToBase64 } from "../../../shared/src/encoding/base64";
import { isHex } from "../../../shared/src/encoding/hex";
import { contentType } from "../../../shared/src/site/content";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { isRecord, parseJson } from "../../../shared/src/util/json";
import {
  accessGroupIsSubset,
  accessGroupMatches,
  accessGroupUsesOnlyDomains,
  safeProjectIdentifier,
  workspaceFromEmail,
  type AccessGroup,
} from "./access";
import type { AuthUser } from "./auth";
import type { ServerConfigShape } from "./config";
import {
  PrimitiveDb,
  PrimitiveDbConflict,
  PrimitiveDbError,
  type JsonValue,
  type PrimitiveDbRecord,
  type PrimitiveDbShape,
} from "./db";
import { makeObjectSiteFiles } from "./object-site-files";
import type { PublishRequest } from "./publish-request";
import { ObjectStorage, StorageConflict, StorageError, type ObjectStorageShape } from "./storage";
import { randomRevisionId, randomSlug, sha256Hex } from "./tokens";

const MAX_ROUTE_ATTEMPTS = 20;
const PROJECTS_NAMESPACE = "projects";
const ROUTES_NAMESPACE = "routes";
const OWNER_INDEX_NAMESPACE = "projects-by-owner";

export interface SiteOwner {
  readonly id: string;
  readonly email: string;
}

export interface SiteFileObject {
  readonly path: SitePath;
  readonly objectKey: string;
  readonly sha256: string;
  readonly size: number;
  readonly contentType: string;
}

export interface SiteRecord {
  readonly version: 3;
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: AccessGroup;
  readonly owner: SiteOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentRevisionId: string;
  readonly currentOpenPath: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface RouteRecord {
  readonly version: 1;
  readonly routePath: string;
  readonly workspace: string;
  readonly project: string;
}

export interface OwnerProjectRecord {
  readonly version: 1;
  readonly workspace: string;
  readonly project: string;
}

export interface SiteRevisionRecord {
  readonly version: 2;
  readonly workspace: string;
  readonly project: string;
  readonly revisionId: string;
  readonly createdAt: string;
  readonly openPath: string;
  readonly files: ReadonlyArray<SiteFileObject>;
}

export interface LoadedSite {
  readonly record: SiteRecord;
  readonly revision: SiteRevisionRecord;
  readonly siteFiles: ReturnType<typeof makeObjectSiteFiles>;
}

export interface PublishResult {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: AccessGroup;
  readonly openPath: string;
}

export class SiteStoreError extends Data.TaggedError("SiteStoreError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SiteStoreShape {
  readonly publish: (
    request: PublishRequest,
    user: AuthUser,
    config: ServerConfigShape,
  ) => Effect.Effect<PublishResult, SiteStoreError | StorageError>;
  readonly loadByRoute: (routePath: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
  readonly loadProject: (workspace: string, project: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
  readonly listProjects: (user: AuthUser) => Effect.Effect<ReadonlyArray<SiteRecord>, SiteStoreError | StorageError>;
  readonly unpublish: (
    workspace: string,
    project: string,
    user: AuthUser,
  ) => Effect.Effect<SiteRecord, SiteStoreError | StorageError>;
  readonly deleteProject: (
    workspace: string,
    project: string,
    user: AuthUser,
  ) => Effect.Effect<void, SiteStoreError | StorageError>;
  readonly bundle: (
    workspace: string,
    project: string,
  ) => Effect.Effect<PublishRequest["bundle"] | null, SiteStoreError | StorageError>;
}

export class SiteStore extends Context.Tag("@scratchwork/server/SiteStore")<SiteStore, SiteStoreShape>() {}

export const SiteStoreLive: Layer.Layer<SiteStore, never, ObjectStorage | PrimitiveDb> = Layer.effect(
  SiteStore,
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    const db = yield* PrimitiveDb;
    return makeSiteStore(storage, db);
  }),
);

const SiteOwnerSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
});

const SiteFileObjectSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.filter((path) => isSafeSitePath(path) || "Invalid site path")),
  objectKey: Schema.String,
  sha256: Schema.String.pipe(Schema.filter((hash) => hash.length === 64 && isHex(hash) || "Invalid SHA-256")),
  size: Schema.Number.pipe(Schema.filter((size) => Number.isInteger(size) && size >= 0 || "Invalid file size")),
  contentType: Schema.String,
});

const SiteRecordSchema = Schema.Struct({
  version: Schema.Literal(3),
  workspace: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid project")),
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

const RouteRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  routePath: Schema.String.pipe(Schema.filter((value) => safeRoutePath(value) || "Invalid route path")),
  workspace: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid project")),
});

const OwnerProjectRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  workspace: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid project")),
});

const SiteRevisionRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  workspace: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid workspace")),
  project: Schema.String.pipe(Schema.filter((value) => safeProjectIdentifier(value) || "Invalid project")),
  revisionId: Schema.String,
  createdAt: Schema.String,
  openPath: Schema.String,
  files: Schema.Array(SiteFileObjectSchema),
}).pipe(
  Schema.filter((revision) => uniquePaths(revision.files) || "Duplicate revision paths"),
);

interface LoadedDbRecord<A> {
  readonly value: A;
  readonly version: number;
  readonly updatedAt: string;
}

/** Creates the SiteStore service over concrete object storage and primitive DB backends. */
function makeSiteStore(storage: ObjectStorageShape, db: PrimitiveDbShape): SiteStoreShape {
  return SiteStore.of({
    publish: (request, user, config) => publishProject(storage, db, request, user, config),
    loadByRoute: (routePath) => loadPublishedSiteByRoute(storage, db, routePath),
    loadProject: (workspace, project) => loadPublishedSite(storage, db, workspace, project),
    listProjects: (user) => listProjects(storage, db, user),
    unpublish: (workspace, project, user) => unpublishProject(db, workspace, project, user),
    deleteProject: (workspace, project, user) => deleteProject(db, workspace, project, user),
    bundle: (workspace, project) => projectBundle(storage, db, workspace, project),
  });
}

/** Publishes a new project or creates a new revision for an existing project. */
function publishProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  config: ServerConfigShape,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const workspace = request.workspace ?? defaultWorkspace(config, user);
    const project = request.project;
    if (workspace == null) {
      return yield* Effect.fail(new SiteStoreError({ status: 400, message: "workspace is required" }));
    }
    if (project == null) {
      return yield* Effect.fail(new SiteStoreError({ status: 400, message: "project is required" }));
    }
    yield* requireProjectIdentifier("workspace", workspace);
    yield* requireProjectIdentifier("project", project);

    const loaded = yield* loadSiteRecord(db, workspace, project);
    const visibility = request.visibility ?? loaded?.value.visibility ?? config.defaultVisibility;
    yield* validateVisibility(visibility, config);

    if (loaded == null) {
      return yield* createProject(storage, db, request, user, config, workspace, project, visibility);
    }
    return yield* updateProject(storage, db, request, user, loaded, visibility);
  });
}

/** Creates a new project record and route index entry. */
function createProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  config: ServerConfigShape,
  workspace: string,
  project: string,
  visibility: AccessGroup,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt += 1) {
      const routePath = routePathForProject(config, user, workspace, project);
      const result = yield* writeNewProject(storage, db, request, user, workspace, project, routePath, visibility).pipe(
        Effect.catchTag("SiteStoreError", (error) =>
          error.status === 409 && config.projectPath === "random"
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      );
      if (result != null) return result;
    }
    return yield* Effect.fail(new SiteStoreError({ status: 500, message: "Could not allocate project URL" }));
  });
}

/** Writes blobs, an immutable revision, a route index entry, and the project record. */
function writeNewProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  workspace: string,
  project: string,
  routePath: string,
  visibility: AccessGroup,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, workspace, project, request, now);
    const record = siteRecord({
      workspace,
      project,
      routePath,
      visibility,
      user,
      createdAt: now,
      updatedAt: now,
      revision,
    });
    yield* putRouteRecord(db, routePath, workspace, project, { ifNoneMatch: "*" });
    const written = yield* putProjectRecord(db, record, { ifNoneMatch: "*" });
    yield* putOwnerIndex(db, record).pipe(Effect.catchAll(() => Effect.void));
    return {
      workspace: written.value.workspace,
      project: written.value.project,
      routePath: written.value.routePath,
      visibility: written.value.visibility,
      openPath: request.openPath,
    };
  });
}

/** Writes a new immutable revision and flips an existing project pointer. */
function updateProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  loaded: LoadedDbRecord<SiteRecord>,
  visibility: AccessGroup,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    if (!canWriteProject(loaded.value, user)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Only the project owner can publish updates" }));
    }

    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, loaded.value.workspace, loaded.value.project, request, now);
    const record = siteRecord({
      workspace: loaded.value.workspace,
      project: loaded.value.project,
      routePath: loaded.value.routePath,
      visibility,
      user: loaded.value.owner,
      createdAt: loaded.value.createdAt,
      updatedAt: now,
      revision,
    });
    const written = yield* putProjectRecord(db, record, { ifMatch: loaded.version });
    yield* putOwnerIndex(db, record).pipe(Effect.catchAll(() => Effect.void));
    return {
      workspace: written.value.workspace,
      project: written.value.project,
      routePath: written.value.routePath,
      visibility: written.value.visibility,
      openPath: request.openPath,
    };
  });
}

/** Loads the current project record, revision, and SiteFiles provider. */
function loadPublishedSite(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  workspace: string,
  project: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, workspace, project);
    if (loaded == null) return null;
    const revision = yield* loadRevisionRecord(storage, loaded.value.workspace, loaded.value.project, loaded.value.currentRevisionId);
    if (revision == null) {
      return yield* Effect.fail(
        new SiteStoreError({ status: 500, message: `Missing project revision: ${projectKey(workspace, project)}` }),
      );
    }
    return {
      record: loaded.value,
      revision,
      siteFiles: makeObjectSiteFiles(storage, revision),
    };
  });
}

/** Loads a project through the route-path index. */
function loadPublishedSiteByRoute(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  routePath: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    if (!safeRoutePath(routePath)) return null;
    const route = yield* loadRouteRecord(db, routePath);
    if (route == null) return null;
    return yield* loadPublishedSite(storage, db, route.value.workspace, route.value.project);
  });
}

/** Lists projects owned by the given user. */
function listProjects(
  _storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  user: AuthUser,
): Effect.Effect<ReadonlyArray<SiteRecord>, SiteStoreError> {
  return Effect.gen(function* () {
    const index = yield* db.list<JsonValue>(OWNER_INDEX_NAMESPACE, { prefix: `${encodeKeySegment(user.id)}/` }).pipe(Effect.mapError(dbError));
    const loaded = yield* Effect.forEach(index.records, (record) =>
      decodeDbRecord(record, OwnerProjectRecordSchema).pipe(
        Effect.flatMap((ownerRecord) => loadSiteRecord(db, ownerRecord.value.workspace, ownerRecord.value.project)),
      ),
    );
    return loaded.flatMap((record) => record == null ? [] : [record.value]);
  });
}

/** Sets project visibility to private, preserving all content and owner metadata. */
function unpublishProject(
  db: PrimitiveDbShape,
  workspace: string,
  project: string,
  user: AuthUser,
): Effect.Effect<SiteRecord, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, workspace, project);
    if (loaded == null) return yield* Effect.fail(new SiteStoreError({ status: 404, message: "Project not found" }));
    if (!canWriteProject(loaded.value, user)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Only the project owner can unpublish this project" }));
    }
    const next = { ...loaded.value, visibility: "private", updatedAt: new Date().toISOString() } satisfies SiteRecord;
    return (yield* putProjectRecord(db, next, { ifMatch: loaded.version })).value;
  });
}

/** Deletes the mutable project and route records. Immutable blobs are retained. */
function deleteProject(
  db: PrimitiveDbShape,
  workspace: string,
  project: string,
  user: AuthUser,
): Effect.Effect<void, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, workspace, project);
    if (loaded == null) return;
    if (!canWriteProject(loaded.value, user)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Only the project owner can delete this project" }));
    }
    yield* db.delete(PROJECTS_NAMESPACE, projectKey(workspace, project), { ifMatch: loaded.version }).pipe(Effect.mapError(dbError));
    yield* db.delete(ROUTES_NAMESPACE, loaded.value.routePath).pipe(Effect.catchAll(() => Effect.void));
    yield* db.delete(OWNER_INDEX_NAMESPACE, ownerIndexKey(loaded.value.owner, workspace, project)).pipe(Effect.catchAll(() => Effect.void));
  });
}

/** Reads the current project revision back into a publish bundle. */
function projectBundle(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  workspace: string,
  project: string,
): Effect.Effect<PublishRequest["bundle"] | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const site = yield* loadPublishedSite(storage, db, workspace, project);
    if (site == null) return null;
    const files = yield* Effect.forEach(site.revision.files, (file) =>
      storage.getObject(file.objectKey).pipe(
        Effect.flatMap((object) =>
          object == null
            ? Effect.fail(new SiteStoreError({ status: 500, message: `Missing published object: ${file.path}` }))
            : Effect.succeed({ path: file.path, contentBase64: bytesToBase64(object.body) }),
        ),
      ),
    );
    return { version: 1, files };
  });
}

/** Stores bundle files as content-addressed blobs and returns revision metadata. */
function buildRevision(
  storage: ObjectStorageShape,
  workspace: string,
  project: string,
  request: PublishRequest,
  createdAt: string,
): Effect.Effect<SiteRevisionRecord, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const files: Array<SiteFileObject> = [];
    for (const file of request.bundle.files) {
      const bytes = base64ToBytes(file.contentBase64);
      if (bytes == null) {
        return yield* Effect.fail(new SiteStoreError({ status: 400, message: `Invalid base64 content: ${file.path}` }));
      }
      const hash = yield* sha256Hex(bytes);
      const objectKey = blobObjectKey(hash);
      yield* storage.putObject(objectKey, bytes, {
        contentType: contentType(file.path),
        ifNoneMatch: "*",
      }).pipe(
        Effect.catchTag("StorageConflict", () => Effect.succeed({})),
      );
      files.push({
        path: file.path,
        objectKey,
        sha256: hash,
        size: bytes.byteLength,
        contentType: contentType(file.path),
      });
    }

    const revision: SiteRevisionRecord = {
      version: 2,
      workspace,
      project,
      revisionId: randomRevisionId(),
      createdAt,
      openPath: request.openPath,
      files,
    };
    yield* storage.putText(revisionRecordKey(workspace, project, revision.revisionId), serialize(revision), {
      contentType: "application/json; charset=utf-8",
      ifNoneMatch: "*",
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StorageConflict
          ? new SiteStoreError({ status: 409, message: "Revision already exists", cause: error })
          : error,
      ),
    );
    return revision;
  });
}

/** Returns true when the user may read a project under server policy. */
export function canReadProject(record: SiteRecord, user: AuthUser | null, config: ServerConfigShape): boolean {
  if (!accessGroupIsSubset(record.visibility, config.maxVisibility)) return false;
  if (user != null && canWriteProject(record, user)) return true;
  return accessGroupMatches(record.visibility, user);
}

/** Returns true when the user owns the project. */
export function canWriteProject(record: SiteRecord, user: AuthUser): boolean {
  return record.owner.id === user.id || record.owner.email.toLowerCase() === user.email.toLowerCase();
}

/** Splits a content path into the longest route prefix and remaining site path. */
export function candidateRoutePaths(pathname: string): ReadonlyArray<string> {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/").filter((segment) => segment !== "");
  const candidates: Array<string> = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).map(decodePathSegment).join("/");
    if (safeRoutePath(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/** Computes the site path remainder for a matched route path. */
export function routeRest(pathname: string, routePath: string): string | null {
  const normalized = `/${pathname.replace(/^\/+/, "")}`;
  const route = `/${routePath}`;
  if (normalized === route) return null;
  if (normalized === `${route}/`) return "/";
  if (!normalized.startsWith(`${route}/`)) return "/";
  return normalized.slice(route.length);
}

/** Builds the stable project key used by API paths and DB records. */
export function projectKey(workspace: string, project: string): string {
  return `${workspace}/${project}`;
}

/** Builds the metadata-only project pointer for a current revision. */
function siteRecord(input: {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: AccessGroup;
  readonly user: AuthUser | SiteOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: SiteRevisionRecord;
}): SiteRecord {
  return {
    version: 3,
    workspace: input.workspace,
    project: input.project,
    routePath: input.routePath,
    visibility: input.visibility,
    owner: ownerFromUser(input.user),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currentRevisionId: input.revision.revisionId,
    currentOpenPath: input.revision.openPath,
    fileCount: input.revision.files.length,
    totalBytes: input.revision.files.reduce((total, file) => total + file.size, 0),
  };
}

function validateVisibility(visibility: AccessGroup, config: ServerConfigShape): Effect.Effect<void, SiteStoreError> {
  if (!accessGroupIsSubset(visibility, config.maxVisibility)) {
    return Effect.fail(new SiteStoreError({ status: 403, message: `Visibility ${visibility} exceeds server maxVisibility ${config.maxVisibility}` }));
  }
  if (!accessGroupUsesOnlyDomains(visibility, config.shareAllowedDomains)) {
    return Effect.fail(new SiteStoreError({ status: 403, message: `Visibility ${visibility} is outside this server's shareAllowedDomains` }));
  }
  return Effect.void;
}

function defaultWorkspace(config: ServerConfigShape, user: AuthUser): string | null {
  if (config.defaultWorkspace === "required") return null;
  if (config.defaultWorkspace === "random") return randomSlug();
  return workspaceFromEmail(user.email);
}

function routePathForProject(
  config: ServerConfigShape,
  user: AuthUser,
  workspace: string,
  project: string,
): string {
  if (config.projectPath === "random") return randomSlug();
  if (config.projectPath === "workspace/project") return `${workspace}/${project}`;
  const email = user.email.toLowerCase();
  const username = workspaceFromEmail(email);
  if (config.projectPath === "username/project") return `${username}/${project}`;
  const domain = email.split("@")[1];
  return domain == null ? `${workspace}/${project}` : `${domain}/${username}/${project}`;
}

function loadSiteRecord(
  db: PrimitiveDbShape,
  workspace: string,
  project: string,
): Effect.Effect<LoadedDbRecord<SiteRecord> | null, SiteStoreError> {
  return db.get<JsonValue>(PROJECTS_NAMESPACE, projectKey(workspace, project)).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((record) => record == null ? Effect.succeed(null) : decodeDbRecord(record, SiteRecordSchema)),
  );
}

function loadRouteRecord(
  db: PrimitiveDbShape,
  routePath: string,
): Effect.Effect<LoadedDbRecord<RouteRecord> | null, SiteStoreError> {
  return db.get<JsonValue>(ROUTES_NAMESPACE, routePath).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((record) => record == null ? Effect.succeed(null) : decodeDbRecord(record, RouteRecordSchema)),
  );
}

function putProjectRecord(
  db: PrimitiveDbShape,
  record: SiteRecord,
  options: { readonly ifNoneMatch?: "*"; readonly ifMatch?: number },
): Effect.Effect<LoadedDbRecord<SiteRecord>, SiteStoreError> {
  return db.put(PROJECTS_NAMESPACE, projectKey(record.workspace, record.project), record as unknown as JsonValue, options).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((written) => decodeDbRecord(written, SiteRecordSchema)),
  );
}

function putRouteRecord(
  db: PrimitiveDbShape,
  routePath: string,
  workspace: string,
  project: string,
  options: { readonly ifNoneMatch?: "*" },
): Effect.Effect<LoadedDbRecord<RouteRecord>, SiteStoreError> {
  const record: RouteRecord = { version: 1, routePath, workspace, project };
  return db.put(ROUTES_NAMESPACE, routePath, record as unknown as JsonValue, options).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((written) => decodeDbRecord(written, RouteRecordSchema)),
  );
}

function putOwnerIndex(db: PrimitiveDbShape, record: SiteRecord): Effect.Effect<void, SiteStoreError> {
  const value: OwnerProjectRecord = { version: 1, workspace: record.workspace, project: record.project };
  return db.put(OWNER_INDEX_NAMESPACE, ownerIndexKey(record.owner, record.workspace, record.project), value as unknown as JsonValue).pipe(
    Effect.asVoid,
    Effect.mapError(dbError),
  );
}

function decodeDbRecord<A, I, R>(
  record: PrimitiveDbRecord<JsonValue>,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<LoadedDbRecord<A>, SiteStoreError, R> {
  return Schema.decodeUnknown(schema)(record.value, { errors: "all" }).pipe(
    Effect.mapError((error) =>
      new SiteStoreError({
        status: 500,
        message: `Invalid stored DB record ${record.namespace}/${record.key}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
      }),
    ),
    Effect.map((value) => ({ value, version: record.version, updatedAt: record.updatedAt })),
  );
}

function loadRevisionRecord(
  storage: ObjectStorageShape,
  workspace: string,
  project: string,
  revisionId: string,
): Effect.Effect<SiteRevisionRecord | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const key = revisionRecordKey(workspace, project, revisionId);
    const object = yield* storage.getObject(key);
    if (object == null) return null;
    const parsed = parseJson(new TextDecoder().decode(object.body));
    if (!isRecord(parsed)) {
      return yield* Effect.fail(new SiteStoreError({ status: 500, message: `Invalid stored JSON: ${key}` }));
    }
    return yield* Schema.decodeUnknown(SiteRevisionRecordSchema)(parsed, { errors: "all" }).pipe(
      Effect.mapError((error) =>
        new SiteStoreError({
          status: 500,
          message: `Invalid stored revision ${key}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        }),
      ),
    );
  });
}

function requireProjectIdentifier(label: string, value: string): Effect.Effect<void, SiteStoreError> {
  return safeProjectIdentifier(value)
    ? Effect.void
    : Effect.fail(new SiteStoreError({ status: 400, message: `Invalid ${label}: ${value}` }));
}

function safeRoutePath(routePath: string): boolean {
  return routePath.length > 0 && routePath.length <= 512 && routePath.split("/").every(safeProjectIdentifier);
}

function revisionRecordKey(workspace: string, project: string, revisionId: string): string {
  return `projects/${workspace}/${project}/revisions/${revisionId}.json`;
}

function blobObjectKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

function ownerIndexKey(owner: SiteOwner, workspace: string, project: string): string {
  return `${encodeKeySegment(owner.id)}/${workspace}/${project}`;
}

function encodeKeySegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function dbError(error: PrimitiveDbError | PrimitiveDbConflict): SiteStoreError {
  if (error instanceof PrimitiveDbConflict) {
    return new SiteStoreError({ status: 409, message: error.message, cause: error });
  }
  return new SiteStoreError({ status: 500, message: error.message, cause: error });
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function ownerFromUser(user: AuthUser | SiteOwner): SiteOwner {
  return { id: user.id, email: user.email.toLowerCase() };
}

function uniquePaths(files: ReadonlyArray<{ readonly path: string }>): boolean {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) return false;
    paths.add(file.path);
  }
  return true;
}
