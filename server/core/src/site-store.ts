/**
 * The SiteStore service: publishing (content-addressed blobs + an immutable revision +
 * pointer records written with optimistic-concurrency preconditions), loading published
 * sites by route or project key, listing, unpublishing, deleting, and bundle export.
 * See site-records.ts for the persisted data model.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { base64ToBytes, bytesToBase64 } from "../../../shared/src/encoding/base64";
import { contentType } from "../../../shared/src/site/content";
import {
  accessGroupIsSubset,
  accessGroupMatches,
  accessGroupUsesOnlyDomains,
  isReservedSlug,
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
import { safeRoutePath } from "./routes";
import {
  blobObjectKey,
  OWNER_INDEX_NAMESPACE,
  OwnerProjectRecordSchema,
  ownerIndexKey,
  ownerIndexPrefix,
  PROJECTS_NAMESPACE,
  projectKey,
  ROUTES_NAMESPACE,
  revisionRecordKey,
  RouteRecordSchema,
  SiteRecordSchema,
  SiteRevisionRecordSchema,
  type RouteRecord,
  type SiteFileObject,
  type SiteOwner,
  type SiteRecord,
  type SiteRevisionRecord,
} from "./site-records";
import { ObjectStorage, sha256Hex, StorageConflict, StorageError, type ObjectStorageShape } from "./storage";
import { randomRevisionId, randomSlug } from "./tokens";

/** How many random route paths to try before giving up on a publish. */
const MAX_ROUTE_ATTEMPTS = 20;

/** A published site loaded for serving: pointer, current revision, and its file reader. */
export interface LoadedSite {
  readonly record: SiteRecord;
  readonly revision: SiteRevisionRecord;
  readonly siteFiles: ReturnType<typeof makeObjectSiteFiles>;
}

/** What publish returns to the CLI. */
export interface PublishResult {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: AccessGroup;
  readonly openPath: string;
}

/** Site-store failure; `status` becomes the HTTP response status. */
export class SiteStoreError extends Data.TaggedError("SiteStoreError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The site-store service contract. */
export interface SiteStoreShape {
  /** Publishes a new project or a new revision of an existing one. */
  readonly publish: (
    request: PublishRequest,
    user: AuthUser,
    config: ServerConfigShape,
  ) => Effect.Effect<PublishResult, SiteStoreError | StorageError>;
  /** Loads a published site through the route-path index. */
  readonly loadByRoute: (routePath: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
  /** Loads a published site by workspace and project name. */
  readonly loadProject: (workspace: string, project: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
  /** Lists the projects the user owns. */
  readonly listProjects: (user: AuthUser) => Effect.Effect<ReadonlyArray<SiteRecord>, SiteStoreError | StorageError>;
  /** Sets a project's visibility to private, keeping all content. */
  readonly unpublish: (
    workspace: string,
    project: string,
    user: AuthUser,
  ) => Effect.Effect<SiteRecord, SiteStoreError | StorageError>;
  /** Deletes the project pointer and indexes; immutable blobs are retained. */
  readonly deleteProject: (
    workspace: string,
    project: string,
    user: AuthUser,
  ) => Effect.Effect<void, SiteStoreError | StorageError>;
  /** Reads the current revision back into a publish bundle for clone workflows. */
  readonly bundle: (
    workspace: string,
    project: string,
  ) => Effect.Effect<PublishRequest["bundle"] | null, SiteStoreError | StorageError>;
}

/** Service tag for the site store. */
export class SiteStore extends Context.Tag("@scratchwork/server/SiteStore")<SiteStore, SiteStoreShape>() {}

/** Provides the site store over the ObjectStorage and PrimitiveDb services. */
export const SiteStoreLive: Layer.Layer<SiteStore, never, ObjectStorage | PrimitiveDb> = Layer.effect(
  SiteStore,
  Effect.gen(function* () {
    const storage = yield* ObjectStorage;
    const db = yield* PrimitiveDb;
    return makeSiteStore(storage, db);
  }),
);

/** Creates the SiteStore service over concrete object storage and primitive DB backends. */
function makeSiteStore(storage: ObjectStorageShape, db: PrimitiveDbShape): SiteStoreShape {
  return SiteStore.of({
    publish: (request, user, config) => publishProject(storage, db, request, user, config),
    loadByRoute: (routePath) => loadPublishedSiteByRoute(storage, db, routePath),
    loadProject: (workspace, project) => loadPublishedSite(storage, db, workspace, project),
    listProjects: (user) => listProjects(db, user),
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
    if (isReservedSlug(workspace)) {
      return yield* Effect.fail(new SiteStoreError({ status: 400, message: `Workspace name is reserved: ${workspace}` }));
    }

    const loaded = yield* loadSiteRecord(db, workspace, project);
    const visibility = request.visibility ?? loaded?.value.visibility ?? config.defaultVisibility;
    yield* validateVisibility(visibility, config);

    if (loaded == null) {
      return yield* createProject(storage, db, request, user, config, workspace, project, visibility);
    }
    return yield* updateProject(storage, db, request, user, loaded, visibility);
  });
}

/** Creates a new project record and route index entry, retrying random routes on collision. */
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
      const firstSegment = routePath.split("/")[0] ?? "";
      if (isReservedSlug(firstSegment)) {
        return yield* Effect.fail(new SiteStoreError({
          status: 400,
          message: `Project URL /${routePath} would shadow the reserved /${firstSegment} route`,
        }));
      }
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
    const route = yield* putRouteRecord(db, routePath, workspace, project, { ifNoneMatch: "*" });
    // The route is claimed before the project record exists; release it on failure so a
    // partial write cannot permanently squat the route path.
    const written = yield* putProjectRecord(db, record, { ifNoneMatch: "*" }).pipe(
      Effect.tapError(() =>
        db.delete(ROUTES_NAMESPACE, routePath, { ifMatch: route.version }).pipe(Effect.ignore),
      ),
    );
    yield* putOwnerIndex(db, record).pipe(Effect.ignore);
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
    yield* putOwnerIndex(db, record).pipe(Effect.ignore);
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

/** Lists projects owned by the given user via the owner index. */
function listProjects(
  db: PrimitiveDbShape,
  user: AuthUser,
): Effect.Effect<ReadonlyArray<SiteRecord>, SiteStoreError> {
  return Effect.gen(function* () {
    const prefix = ownerIndexPrefix(user.id);
    const index: Array<PrimitiveDbRecord<JsonValue>> = [];
    let startAfter: string | undefined;
    do {
      const page = yield* db.list<JsonValue>(OWNER_INDEX_NAMESPACE, { prefix, startAfter, limit: 1000 }).pipe(Effect.mapError(dbError));
      index.push(...page.records);
      startAfter = page.cursor;
    } while (startAfter != null);
    const loaded = yield* Effect.forEach(index, (record) =>
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
    yield* db.delete(ROUTES_NAMESPACE, loaded.value.routePath).pipe(Effect.ignore);
    yield* db.delete(OWNER_INDEX_NAMESPACE, ownerIndexKey(loaded.value.owner, workspace, project)).pipe(Effect.ignore);
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
        // A conflict means the identical content-addressed blob already exists.
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
      Effect.catchTag("StorageConflict", (error) =>
        Effect.fail(new SiteStoreError({ status: 409, message: "Revision already exists", cause: error })),
      ),
    );
    return revision;
  });
}

/** Returns true when the user may read a project under server policy. The owner can always
 * read their own project, even when a later maxVisibility tightening exceeds the stored
 * visibility — the ceiling gates other readers, not ownership. */
export function canReadProject(record: SiteRecord, user: AuthUser | null, config: ServerConfigShape): boolean {
  if (user != null && canWriteProject(record, user)) return true;
  if (!accessGroupIsSubset(record.visibility, config.maxVisibility)) return false;
  return accessGroupMatches(record.visibility, user);
}

/** Returns true when the user owns the project. */
export function canWriteProject(record: SiteRecord, user: AuthUser): boolean {
  return record.owner.id === user.id || record.owner.email.toLowerCase() === user.email.toLowerCase();
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

/** Fails when the requested visibility exceeds server-wide sharing policy. */
function validateVisibility(visibility: AccessGroup, config: ServerConfigShape): Effect.Effect<void, SiteStoreError> {
  if (!accessGroupIsSubset(visibility, config.maxVisibility)) {
    return Effect.fail(new SiteStoreError({ status: 403, message: `Visibility ${visibility} exceeds server maxVisibility ${config.maxVisibility}` }));
  }
  if (!accessGroupUsesOnlyDomains(visibility, config.shareAllowedDomains)) {
    return Effect.fail(new SiteStoreError({ status: 403, message: `Visibility ${visibility} is outside this server's shareAllowedDomains` }));
  }
  return Effect.void;
}

/** Resolves the workspace for a publish that omits one, per config.defaultWorkspace:
 * null (caller must supply one), a random slug, or the user's email local part. */
function defaultWorkspace(config: ServerConfigShape, user: AuthUser): string | null {
  if (config.defaultWorkspace === "required") return null;
  if (config.defaultWorkspace === "random") return randomSlug();
  return workspaceFromEmail(user.email);
}

/** Maps config.projectPath to a new project's route: a random slug, workspace/project,
 * username/project, or domain/username/project (workspace/project when the email has no domain). */
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

/** A decoded DB record plus the version/updatedAt metadata needed for conditional writes. */
interface LoadedDbRecord<A> {
  readonly value: A;
  readonly version: number;
  readonly updatedAt: string;
}

/** Loads and decodes the project pointer, or null when the project does not exist. */
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

/** Loads and decodes a route-index entry, or null when the route is unclaimed. */
function loadRouteRecord(
  db: PrimitiveDbShape,
  routePath: string,
): Effect.Effect<LoadedDbRecord<RouteRecord> | null, SiteStoreError> {
  return db.get<JsonValue>(ROUTES_NAMESPACE, routePath).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((record) => record == null ? Effect.succeed(null) : decodeDbRecord(record, RouteRecordSchema)),
  );
}

/** Writes the project pointer under the given precondition and decodes the result. */
function putProjectRecord(
  db: PrimitiveDbShape,
  record: SiteRecord,
  options: { readonly ifNoneMatch?: "*"; readonly ifMatch?: number },
): Effect.Effect<LoadedDbRecord<SiteRecord>, SiteStoreError> {
  return db.put(PROJECTS_NAMESPACE, projectKey(record.workspace, record.project), record, options).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((written) => decodeDbRecord(written, SiteRecordSchema)),
  );
}

/** Claims or updates a route-index entry under the given precondition. */
function putRouteRecord(
  db: PrimitiveDbShape,
  routePath: string,
  workspace: string,
  project: string,
  options: { readonly ifNoneMatch?: "*" },
): Effect.Effect<LoadedDbRecord<RouteRecord>, SiteStoreError> {
  const record: RouteRecord = { version: 1, routePath, workspace, project };
  return db.put(ROUTES_NAMESPACE, routePath, record, options).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((written) => decodeDbRecord(written, RouteRecordSchema)),
  );
}

/** Upserts the owner-index entry that makes the project appear in listings. */
function putOwnerIndex(db: PrimitiveDbShape, record: SiteRecord): Effect.Effect<void, SiteStoreError> {
  const value = { version: 1, workspace: record.workspace, project: record.project };
  return db.put(OWNER_INDEX_NAMESPACE, ownerIndexKey(record.owner, record.workspace, record.project), value).pipe(
    Effect.asVoid,
    Effect.mapError(dbError),
  );
}

/** Decodes one stored DB record against its schema, keeping the write-precondition metadata. */
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

/** Decodes revision JSON straight from object-storage text. */
const SiteRevisionJsonSchema = Schema.parseJson(SiteRevisionRecordSchema);

/** Loads and decodes one immutable revision document, or null when it does not exist. */
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
    return yield* Schema.decodeUnknown(SiteRevisionJsonSchema)(new TextDecoder().decode(object.body), { errors: "all" }).pipe(
      Effect.mapError((error) =>
        new SiteStoreError({
          status: 500,
          message: `Invalid stored revision ${key}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        }),
      ),
    );
  });
}

/** Fails with 400 when a workspace or project name is not a safe identifier. */
function requireProjectIdentifier(label: string, value: string): Effect.Effect<void, SiteStoreError> {
  return safeProjectIdentifier(value)
    ? Effect.void
    : Effect.fail(new SiteStoreError({ status: 400, message: `Invalid ${label}: ${value}` }));
}

/** Maps primitive-DB failures onto site-store errors (409 for conflicts, 500 otherwise). */
function dbError(error: PrimitiveDbError | PrimitiveDbConflict): SiteStoreError {
  if (error instanceof PrimitiveDbConflict) {
    return new SiteStoreError({ status: 409, message: error.message, cause: error });
  }
  return new SiteStoreError({ status: 500, message: error.message, cause: error });
}

/** Serializes a stored JSON document with a trailing newline. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Normalizes a user or stored owner into the persisted owner shape. */
function ownerFromUser(user: AuthUser | SiteOwner): SiteOwner {
  return { id: user.id, email: user.email.toLowerCase() };
}
