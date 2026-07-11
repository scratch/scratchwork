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
import type { PublishResponse } from "../../../shared/src/publish/api";
import { contentType } from "../../../shared/src/site/content";
import {
  accessGroupMatches,
  accessGroupModify,
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

/** What publish returns to the CLI: the shared wire response minus the request-scoped
 * `url`, which the HTTP layer adds. `project` is authoritative: on a random-name server
 * it is how the CLI learns the assigned name. */
export type PublishResult = Omit<PublishResponse, "url">;

/** A user's effective permission level on one project, from least to greatest. Each
 * level implies the ones below it; `owner` is fixed at creation and cannot be granted. */
export type ProjectRole = "none" | "read" | "write" | "admin" | "owner";

/** The roles a share grant can assign (ownership is not grantable). */
export type ShareRole = "read" | "write" | "admin";

/** Requested grant changes for one share call; targets are emails or @domain groups.
 * `add` assigns the role (moving targets already holding another role), `remove` strips
 * every role. */
export interface ShareChanges {
  readonly role: ShareRole;
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

/** What share returns: the updated pointer plus advisory warnings (grants that were
 * revoked but leave the account with access anyway). */
export interface ShareResult {
  readonly record: SiteRecord;
  readonly warnings: ReadonlyArray<string>;
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
  /** Sets a project private, keeping all content. */
  readonly unpublish: (
    project: string,
    user: AuthUser,
    config: ServerConfigShape,
  ) => Effect.Effect<SiteRecord, SiteStoreError | StorageError>;
  /** Grants and revokes individual email/@domain access on a project's grant groups. */
  readonly share: (
    project: string,
    user: AuthUser,
    changes: ShareChanges,
    config: ServerConfigShape,
  ) => Effect.Effect<ShareResult, SiteStoreError | StorageError>;
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
    unpublish: (project, user, config) => unpublishProject(db, project, user, config),
    share: (project, user, changes, config) => updateProjectSharing(db, project, user, changes, config),
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
    const isPublic = request.isPublic ?? loaded?.value.isPublic ?? false;
    yield* validateIsPublic(isPublic, config);

    if (loaded != null && requested != null) {
      if (!roleAtLeast(projectRole(loaded.value, user, config), "write")) {
        return yield* Effect.fail(projectNameTaken(requested));
      }
      return yield* updateProject(storage, db, request, user, loaded, isPublic, config);
    }

    if (config.usersCanSetProjectNames) {
      if (requested == null) {
        return yield* Effect.fail(new SiteStoreError({ status: 400, message: "project name is required (pass --project)" }));
      }
      if (isReservedSlug(requested)) {
        return yield* Effect.fail(new SiteStoreError({ status: 400, message: `Project name is reserved: ${requested}` }));
      }
      return yield* writeNewProject(storage, db, request, user, requested, isPublic).pipe(
        Effect.catchTag("PrimitiveDbConflict", () => Effect.fail(projectNameTaken(requested))),
      );
    }

    return yield* createRandomProject(storage, db, request, user, isPublic);
  });
}

/** Creates a project under a server-minted random name, retrying only name collisions
 * (each retry rebuilds the complete create attempt for a fresh candidate). */
function createRandomProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  isPublic: boolean,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < RANDOM_NAME_ATTEMPTS; attempt += 1) {
      const slug = randomSlug();
      // Defense in depth: today's slug alphabet cannot produce a reserved name.
      if (isReservedSlug(slug)) continue;
      if ((yield* loadSiteRecord(db, slug)) != null) continue;
      const result = yield* writeNewProject(storage, db, request, user, slug, isPublic).pipe(
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
  isPublic: boolean,
): Effect.Effect<PublishResult, SiteStoreError | StorageError | PrimitiveDbConflict> {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, project, request, now);
    const record = siteRecord({
      project,
      isPublic,
      readers: "private",
      writers: "private",
      admins: "private",
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
      isPublic: written.value.isPublic,
      openPath: request.openPath,
    };
  });
}

/** Writes a new immutable revision and flips an existing project pointer. Writers may
 * publish content; flipping the public toggle along the way stays an admin action. */
function updateProject(
  storage: ObjectStorageShape,
  db: PrimitiveDbShape,
  request: PublishRequest,
  user: AuthUser,
  loaded: LoadedDbRecord<SiteRecord>,
  isPublic: boolean,
  config: ServerConfigShape,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const role = projectRole(loaded.value, user, config);
    if (!roleAtLeast(role, "write")) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Publishing updates requires write access to this project" }));
    }
    if (isPublic !== loaded.value.isPublic && !roleAtLeast(role, "admin")) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Changing a project between public and private requires admin access" }));
    }

    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, loaded.value.project, request, now);
    const record = siteRecord({
      project: loaded.value.project,
      isPublic,
      readers: loaded.value.readers,
      writers: loaded.value.writers,
      admins: loaded.value.admins,
      user: loaded.value.owner,
      createdAt: loaded.value.createdAt,
      updatedAt: now,
      revision,
    });
    const written = yield* putProjectRecord(db, record, { ifMatch: loaded.version });
    yield* putOwnerIndex(db, written.value).pipe(Effect.ignore);
    return {
      project: written.value.project,
      isPublic: written.value.isPublic,
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

/** Resets a project to owner-only, preserving all content and owner metadata: the
 * project becomes private and every grant is cleared. Fine-grained changes go through
 * share. */
function unpublishProject(
  db: PrimitiveDbShape,
  project: string,
  user: AuthUser,
  config: ServerConfigShape,
): Effect.Effect<SiteRecord, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, project);
    if (loaded == null) return yield* Effect.fail(new SiteStoreError({ status: 404, message: "Project not found" }));
    if (!roleAtLeast(projectRole(loaded.value, user, config), "admin")) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Unpublishing requires admin access to this project" }));
    }
    const next = {
      ...loaded.value,
      isPublic: false,
      readers: "private",
      writers: "private",
      admins: "private",
      updatedAt: new Date().toISOString(),
    } satisfies SiteRecord;
    return (yield* putProjectRecord(db, next, { ifMatch: loaded.version })).value;
  });
}

/** Applies grant/revoke deltas to a project's role groups. `add` assigns the requested
 * role — a target holding a different role is moved, never duplicated — and `remove`
 * strips every role. Grants are validated against server sharing policy; pure revokes are
 * not — the result is strictly narrower than what the policy already admitted, and a
 * later policy tightening must never block revocation. */
function updateProjectSharing(
  db: PrimitiveDbShape,
  project: string,
  user: AuthUser,
  changes: ShareChanges,
  config: ServerConfigShape,
): Effect.Effect<ShareResult, SiteStoreError> {
  return Effect.gen(function* () {
    const loaded = yield* loadSiteRecord(db, project);
    if (loaded == null) return yield* Effect.fail(new SiteStoreError({ status: 404, message: "Project not found" }));
    if (!roleAtLeast(projectRole(loaded.value, user, config), "admin")) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Changing project sharing requires admin access" }));
    }

    const groups = { read: loaded.value.readers, write: loaded.value.writers, admin: loaded.value.admins };
    const modified = {} as Record<ShareRole, AccessGroup>;
    for (const role of ["read", "write", "admin"] as const) {
      // Targets are added to the requested role's group and removed everywhere else.
      modified[role] = yield* accessGroupModify(groups[role], {
        add: role === changes.role ? changes.add : [],
        remove: role === changes.role ? changes.remove : [...changes.remove, ...changes.add],
      }).pipe(Effect.mapError((error) => new SiteStoreError({ status: 400, message: error.message })));
    }
    if (changes.add.length > 0) yield* validateShareGroup(modified[changes.role], config);

    const next = {
      ...loaded.value,
      readers: modified.read,
      writers: modified.write,
      admins: modified.admin,
      updatedAt: new Date().toISOString(),
    } satisfies SiteRecord;
    const written = yield* putProjectRecord(db, next, { ifMatch: loaded.version });
    return { record: written.value, warnings: revokeWarnings(written.value, changes.remove, config) };
  });
}

/** Flags revoked emails that still have access: the owner (always readable to them), an
 * address a remaining grant covers, or a public project — so a revoke never looks more
 * effective than it is. */
function revokeWarnings(
  record: SiteRecord,
  removed: ReadonlyArray<string>,
  config: ServerConfigShape,
): ReadonlyArray<string> {
  const warnings: Array<string> = [];
  for (const target of removed) {
    const email = target.trim().toLowerCase();
    if (!email.includes("@") || email.startsWith("@")) continue;
    if (email === record.owner.email) {
      warnings.push(`${email} owns this project and always has access`);
      continue;
    }
    const remaining = projectRole(record, { id: "", email }, config);
    if (remaining === "none") continue;
    const viaGrant = [record.readers, record.writers, record.admins].some((group) =>
      accessGroupUsesOnlyDomains(group, config.allowedShareDomains) && accessGroupMatches(group, { email }));
    warnings.push(viaGrant
      ? `${email} still has ${remaining} access through remaining grants`
      : `${email} still has read access because the project is public`);
  }
  return warnings;
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
    if (!isProjectOwner(loaded.value, user)) {
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

/** Role precedence, least to greatest. */
const ROLE_ORDER: Record<ProjectRole, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/** Returns true when `role` grants at least `minimum`'s permissions. */
export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimum];
}

/** Resolves a user's effective role on a project under server policy. The owner always
 * holds every role — server policy gates other principals, not ownership. Each granted
 * group is honored only while it sits within allowedShareDomains, and the public toggle
 * only while allowPublicProjects is on, so tightening either setting locks a project
 * down without touching its records. */
export function projectRole(record: SiteRecord, user: AuthUser | null, config: ServerConfigShape): ProjectRole {
  if (user != null && isProjectOwner(record, user)) return "owner";
  const admits = (group: AccessGroup) =>
    accessGroupUsesOnlyDomains(group, config.allowedShareDomains) && accessGroupMatches(group, user);
  if (user != null && admits(record.admins)) return "admin";
  if (user != null && admits(record.writers)) return "write";
  if (admits(record.readers)) return "read";
  if (record.isPublic && config.allowPublicProjects) return "read";
  return "none";
}

/** Returns true when the user may read a project under server policy. */
export function canReadProject(record: SiteRecord, user: AuthUser | null, config: ServerConfigShape): boolean {
  return roleAtLeast(projectRole(record, user, config), "read");
}

/** Returns true when the user owns the project. */
export function isProjectOwner(record: SiteRecord, user: AuthUser): boolean {
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
  readonly isPublic: boolean;
  readonly readers: AccessGroup;
  readonly writers: AccessGroup;
  readonly admins: AccessGroup;
  readonly user: AuthUser | SiteOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: SiteRevisionRecord;
}): SiteRecord {
  return {
    version: 5,
    project: input.project,
    isPublic: input.isPublic,
    readers: input.readers,
    writers: input.writers,
    admins: input.admins,
    owner: ownerFromUser(input.user),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currentRevisionId: input.revision.revisionId,
    currentOpenPath: input.revision.openPath,
    fileCount: input.revision.files.length,
    totalBytes: input.revision.files.reduce((total, file) => total + file.size, 0),
  };
}

/** Fails when a publish asks for a public project on a server that forbids them. */
function validateIsPublic(isPublic: boolean, config: ServerConfigShape): Effect.Effect<void, SiteStoreError> {
  if (isPublic && !config.allowPublicProjects) {
    return Effect.fail(new SiteStoreError({ status: 403, message: "This server does not allow public projects (allowPublicProjects is off)" }));
  }
  return Effect.void;
}

/** Fails when a modified grant group falls outside server-wide sharing policy. */
function validateShareGroup(group: AccessGroup, config: ServerConfigShape): Effect.Effect<void, SiteStoreError> {
  if (!accessGroupUsesOnlyDomains(group, config.allowedShareDomains)) {
    return Effect.fail(new SiteStoreError({ status: 403, message: `Share grant ${group} is outside this server's allowedShareDomains` }));
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
