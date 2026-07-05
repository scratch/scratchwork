/**
 * The SiteStore service: publishing (content-addressed blobs + an immutable revision +
 * pointer records written with optimistic-concurrency preconditions), loading published
 * sites by project name, listing, unpublishing, deleting, and bundle export.
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
  isSafeProjectIdentifier,
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
import {
  blobObjectKey,
  OWNER_INDEX_NAMESPACE,
  OwnerProjectRecordSchema,
  ownerIndexKey,
  ownerIndexPrefix,
  PROJECTS_NAMESPACE,
  revisionRecordKey,
  SiteRecordSchema,
  SiteRevisionRecordSchema,
  type SiteFileObject,
  type SiteOwner,
  type SiteRecord,
  type SiteRevisionRecord,
} from "./site-records";
import { ObjectStorage, sha256Hex, StorageError, type ObjectStorageShape } from "./storage";
import { randomRevisionId, randomSlug } from "./tokens";

/** How many random-name candidates a create attempts before giving up. */
const RANDOM_NAME_ATTEMPTS = 3;

/** A published site loaded for serving: pointer, current revision, and its file reader. */
export interface LoadedSite {
  readonly record: SiteRecord;
  readonly revision: SiteRevisionRecord;
  readonly siteFiles: ReturnType<typeof makeObjectSiteFiles>;
}

/** What publish returns to the CLI. `project` is authoritative: on a random-name server
 * it is how the CLI learns the assigned name. */
export interface PublishResult {
  readonly project: string;
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
  /** Loads a published site by project name. */
  readonly loadProject: (project: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
  /** Lists the projects the user owns. */
  readonly listProjects: (user: AuthUser) => Effect.Effect<ReadonlyArray<SiteRecord>, SiteStoreError | StorageError>;
  /** Sets a project's visibility to private, keeping all content. */
  readonly unpublish: (
    project: string,
    user: AuthUser,
  ) => Effect.Effect<SiteRecord, SiteStoreError | StorageError>;
  /** Deletes the project pointer and owner index; immutable blobs are retained. */
  readonly deleteProject: (
    project: string,
    user: AuthUser,
  ) => Effect.Effect<void, SiteStoreError | StorageError>;
  /** Reads the current revision back into a publish bundle for clone workflows. */
  readonly bundle: (
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
    loadProject: (project) => loadPublishedSite(storage, db, project),
    listProjects: (user) => listProjects(db, user),
    unpublish: (project, user) => unpublishProject(db, project, user),
    deleteProject: (project, user) => deleteProject(db, project, user),
    bundle: (project) => projectBundle(storage, db, project),
  });
}

/** Publishes a new project or creates a new revision for an existing project.
 *
 * Publishing is a name-based upsert. A requested name that exists and is owned by the
 * caller is updated in both naming modes — this is how republish works, including on
 * random-name servers where the CLI echoes the saved slug. A requested name owned by
 * someone else is a 409 in both modes: a stale or copied local config surfaces as an
 * explicit error, never a silent fork. Creation is where the modes differ: user-set
 * names are required and claimed first-writer-wins; random mode discards the request's
 * name and mints a slug. */
function publishProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  config: ServerConfigShape,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const requested = request.project;
    if (requested != null) yield* requireProjectIdentifier(requested);

    const loaded = requested == null ? null : yield* loadSiteRecord(db, requested);
    const visibility = request.visibility ?? loaded?.value.visibility ?? config.defaultVisibility;
    yield* validateVisibility(visibility, config);

    if (loaded != null && requested != null) {
      if (!canWriteProject(loaded.value, user)) {
        return yield* Effect.fail(projectNameTaken(requested));
      }
      return yield* updateProject(storage, db, request, user, loaded, visibility);
    }

    if (config.usersCanSetProjectNames) {
      if (requested == null) {
        return yield* Effect.fail(new SiteStoreError({ status: 400, message: "project name is required (pass --project)" }));
      }
      if (isReservedSlug(requested)) {
        return yield* Effect.fail(new SiteStoreError({ status: 400, message: `Project name is reserved: ${requested}` }));
      }
      return yield* writeNewProject(storage, db, request, user, requested, visibility).pipe(
        Effect.catchTag("PrimitiveDbConflict", () => Effect.fail(projectNameTaken(requested))),
      );
    }

    return yield* createRandomProject(storage, db, request, user, visibility);
  });
}

/** Creates a project under a server-minted random name, retrying only name collisions
 * (each retry rebuilds the complete create attempt for a fresh candidate). */
function createRandomProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  visibility: AccessGroup,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < RANDOM_NAME_ATTEMPTS; attempt += 1) {
      const slug = randomSlug();
      // Defense in depth: today's slug alphabet cannot produce a reserved name.
      if (isReservedSlug(slug)) continue;
      if ((yield* loadSiteRecord(db, slug)) != null) continue;
      const result = yield* writeNewProject(storage, db, request, user, slug, visibility).pipe(
        Effect.catchTag("PrimitiveDbConflict", () => Effect.succeed(null)),
      );
      if (result != null) return result;
    }
    return yield* Effect.fail(new SiteStoreError({ status: 500, message: "Could not allocate a project name" }));
  });
}

/** Writes blobs, an immutable revision, and the project record. The `ifNoneMatch: "*"`
 * put of the record is the single server-wide uniqueness claim on the name; a lost race
 * surfaces as PrimitiveDbConflict for the caller to map. The revision JSON is written
 * before the claim so readers never see a record pointing at a missing revision — a lost
 * race can therefore orphan one revision document under the winner's prefix, which is
 * accepted (revision ids are 16 random bytes and the document is unreferenced). */
function writeNewProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  project: string,
  visibility: AccessGroup,
): Effect.Effect<PublishResult, SiteStoreError | StorageError | PrimitiveDbConflict> {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, project, request, now);
    const record = siteRecord({
      project,
      visibility,
      user,
      createdAt: now,
      updatedAt: now,
      revision,
    });
    const written = yield* db.put(PROJECTS_NAMESPACE, project, record, { ifNoneMatch: "*" }).pipe(
      Effect.mapError((error) => error instanceof PrimitiveDbConflict ? error : dbError(error)),
      Effect.flatMap((result) => decodeDbRecord(result, SiteRecordSchema)),
    );
    yield* putOwnerIndex(db, written.value).pipe(Effect.ignore);
    return {
      project: written.value.project,
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
    const revision = yield* buildRevision(storage, loaded.value.project, request, now);
    const record = siteRecord({
      project: loaded.value.project,
      visibility,
      user: loaded.value.owner,
      createdAt: loaded.value.createdAt,
      updatedAt: now,
      revision,
    });
    const written = yield* putProjectRecord(db, record, { ifMatch: loaded.version });
    yield* putOwnerIndex(db, written.value).pipe(Effect.ignore);
    return {
      project: written.value.project,
      visibility: written.value.visibility,
      openPath: request.openPath,
    };
  });
}

/** Loads the current project record, revision, and SiteFiles provider. */
function loadPublishedSite(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  project: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, project);
    if (loaded == null) return null;
    const revision = yield* loadRevisionRecord(storage, loaded.value.project, loaded.value.currentRevisionId);
    if (revision == null) {
      return yield* Effect.fail(
        new SiteStoreError({ status: 500, message: `Missing project revision: ${project}` }),
      );
    }
    return {
      record: loaded.value,
      revision,
      siteFiles: makeObjectSiteFiles(storage, revision),
    };
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
        Effect.flatMap((ownerRecord) => loadSiteRecord(db, ownerRecord.value.project)),
      ),
    );
    return loaded.flatMap((record) => record == null ? [] : [record.value]);
  });
}

/** Sets project visibility to private, preserving all content and owner metadata. */
function unpublishProject(
  db: PrimitiveDbShape,
  project: string,
  user: AuthUser,
): Effect.Effect<SiteRecord, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, project);
    if (loaded == null) return yield* Effect.fail(new SiteStoreError({ status: 404, message: "Project not found" }));
    if (!canWriteProject(loaded.value, user)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Only the project owner can unpublish this project" }));
    }
    const next = { ...loaded.value, visibility: "private", updatedAt: new Date().toISOString() } satisfies SiteRecord;
    return (yield* putProjectRecord(db, next, { ifMatch: loaded.version })).value;
  });
}

/** Deletes the mutable project record and owner index, releasing the name. Immutable
 * blobs are retained. */
function deleteProject(
  db: PrimitiveDbShape,
  project: string,
  user: AuthUser,
): Effect.Effect<void, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, project);
    if (loaded == null) return;
    if (!canWriteProject(loaded.value, user)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Only the project owner can delete this project" }));
    }
    yield* db.delete(PROJECTS_NAMESPACE, project, { ifMatch: loaded.version }).pipe(Effect.mapError(dbError));
    yield* db.delete(OWNER_INDEX_NAMESPACE, ownerIndexKey(loaded.value.owner, project)).pipe(Effect.ignore);
  });
}

/** Reads the current project revision back into a publish bundle. */
function projectBundle(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  project: string,
): Effect.Effect<PublishRequest["bundle"] | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const site = yield* loadPublishedSite(storage, db, project);
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
      version: 3,
      project,
      revisionId: randomRevisionId(),
      createdAt,
      openPath: request.openPath,
      files,
    };
    yield* storage.putText(revisionRecordKey(project, revision.revisionId), serialize(revision), {
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

/** The canonical name-collision failure, for load-time checks, not-owner publishes, and
 * lost create races alike. Never surface the raw DB conflict message. */
function projectNameTaken(project: string): SiteStoreError {
  return new SiteStoreError({
    status: 409,
    message: `Project name "${project}" is already taken on this server. Choose another with --project.`,
  });
}

/** Builds the metadata-only project pointer for a current revision. */
function siteRecord(input: {
  readonly project: string;
  readonly visibility: AccessGroup;
  readonly user: AuthUser | SiteOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: SiteRevisionRecord;
}): SiteRecord {
  return {
    version: 4,
    project: input.project,
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

/** A decoded DB record plus the version/updatedAt metadata needed for conditional writes. */
interface LoadedDbRecord<A> {
  readonly value: A;
  readonly version: number;
  readonly updatedAt: string;
}

/** Loads and decodes the project pointer, or null when the project does not exist.
 * Rejecting unsafe identifiers here (instead of letting them reach safeDbKey and 500)
 * turns garbage route/API input into a 404 for every caller. */
function loadSiteRecord(
  db: PrimitiveDbShape,
  project: string,
): Effect.Effect<LoadedDbRecord<SiteRecord> | null, SiteStoreError> {
  if (!isSafeProjectIdentifier(project)) return Effect.succeed(null);
  return db.get<JsonValue>(PROJECTS_NAMESPACE, project).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((record) => record == null ? Effect.succeed(null) : decodeDbRecord(record, SiteRecordSchema)),
  );
}

/** Writes the project pointer under the given precondition and decodes the result. */
function putProjectRecord(
  db: PrimitiveDbShape,
  record: SiteRecord,
  options: { readonly ifNoneMatch?: "*"; readonly ifMatch?: number },
): Effect.Effect<LoadedDbRecord<SiteRecord>, SiteStoreError> {
  return db.put(PROJECTS_NAMESPACE, record.project, record, options).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((written) => decodeDbRecord(written, SiteRecordSchema)),
  );
}

/** Upserts the owner-index entry that makes the project appear in listings. */
function putOwnerIndex(db: PrimitiveDbShape, record: SiteRecord): Effect.Effect<void, SiteStoreError> {
  const value = { version: 2, project: record.project };
  return db.put(OWNER_INDEX_NAMESPACE, ownerIndexKey(record.owner, record.project), value).pipe(
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
  project: string,
  revisionId: string,
): Effect.Effect<SiteRevisionRecord | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const key = revisionRecordKey(project, revisionId);
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

/** Fails with 400 when a project name is not a safe identifier. */
function requireProjectIdentifier(value: string): Effect.Effect<void, SiteStoreError> {
  return isSafeProjectIdentifier(value)
    ? Effect.void
    : Effect.fail(new SiteStoreError({ status: 400, message: `Invalid project: ${value}` }));
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
