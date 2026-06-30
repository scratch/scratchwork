import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { base64ToBytes } from "../../../shared/src/encoding/base64";
import { isHex } from "../../../shared/src/encoding/hex";
import { contentType } from "../../../shared/src/site/content";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { isRecord, parseJson } from "../../../shared/src/util/json";
import type { AuthUser } from "./auth";
import { makeObjectSiteFiles } from "./object-site-files";
import type { PublishRequest } from "./publish-request";
import { ObjectStorage, StorageConflict, StorageError, type ObjectStorageShape } from "./storage";
import { randomRevisionId, randomSlug, randomToken, safeSlug, sha256Hex, timingSafeEqual, tokenHash } from "./tokens";

const MAX_SLUG_ATTEMPTS = 20;

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
  readonly version: 2;
  readonly slug: string;
  readonly tokenHash: string;
  readonly owner?: SiteOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentRevisionId: string;
  readonly currentOpenPath: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface SiteRevisionRecord {
  readonly version: 1;
  readonly slug: string;
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
  readonly slug: string;
  readonly token: string;
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
    user: AuthUser | null,
  ) => Effect.Effect<PublishResult, SiteStoreError | StorageError>;
  readonly load: (slug: string) => Effect.Effect<LoadedSite | null, SiteStoreError | StorageError>;
}

export class SiteStore extends Context.Tag("@scratchwork/server/SiteStore")<SiteStore, SiteStoreShape>() {}

export const SiteStoreLive: Layer.Layer<SiteStore, never, ObjectStorage> = Layer.effect(
  SiteStore,
  Effect.map(ObjectStorage, (storage) => makeSiteStore(storage)),
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
  version: Schema.Literal(2),
  slug: Schema.String.pipe(Schema.filter((slug) => safeSlug(slug) || "Invalid slug")),
  tokenHash: Schema.String.pipe(Schema.filter((hash) => /^sha256:[0-9a-f]{64}$/.test(hash) || "Invalid token hash")),
  owner: Schema.optional(SiteOwnerSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentRevisionId: Schema.String,
  currentOpenPath: Schema.String,
  fileCount: Schema.Number.pipe(Schema.filter((count) => Number.isInteger(count) && count >= 0 || "Invalid file count")),
  totalBytes: Schema.Number.pipe(Schema.filter((bytes) => Number.isInteger(bytes) && bytes >= 0 || "Invalid total bytes")),
});

const SiteRevisionRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  slug: Schema.String.pipe(Schema.filter((slug) => safeSlug(slug) || "Invalid slug")),
  revisionId: Schema.String,
  createdAt: Schema.String,
  openPath: Schema.String,
  files: Schema.Array(SiteFileObjectSchema),
}).pipe(
  Schema.filter((revision) => uniquePaths(revision.files) || "Duplicate revision paths"),
);

interface LoadedRecord<A> {
  readonly value: A;
  readonly etag?: string;
}

/** Creates the SiteStore service over a concrete object storage backend. */
function makeSiteStore(storage: ObjectStorageShape): SiteStoreShape {
  return SiteStore.of({
    publish: (request, user) => request.slug == null ? createSite(storage, request, user) : republishSite(storage, request, user),
    load: (slug) => loadPublishedSite(storage, slug),
  });
}

/** Publishes a new site, retrying random slug collisions. */
function createSite(
  storage: ObjectStorageShape,
  request: PublishRequest,
  user: AuthUser | null,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const token = randomToken();
    const hashedToken = yield* tokenHash(token);
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = randomSlug();
      const result = yield* writeNewSite(storage, slug, token, hashedToken, request, user).pipe(
        Effect.catchTag("StorageConflict", () => Effect.succeed(null)),
      );
      if (result != null) return result;
    }
    return yield* Effect.fail(new SiteStoreError({ status: 500, message: "Could not allocate slug" }));
  });
}

/** Writes blobs, revision metadata, and the initial create-only site record. */
function writeNewSite(
  storage: ObjectStorageShape,
  slug: string,
  token: string,
  hashedToken: string,
  request: PublishRequest,
  user: AuthUser | null,
): Effect.Effect<PublishResult, SiteStoreError | StorageError | StorageConflict> {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, slug, request, now);
    const record = siteRecord({
      slug,
      tokenHash: hashedToken,
      user,
      createdAt: now,
      updatedAt: now,
      revision,
    });

    yield* storage.putText(revisionRecordKey(slug, revision.revisionId), serialize(revision), {
      contentType: "application/json; charset=utf-8",
      ifNoneMatch: "*",
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StorageConflict
          ? new SiteStoreError({ status: 409, message: "Revision already exists", cause: error })
          : error,
      ),
    );
    yield* storage.putText(siteRecordKey(slug), serialize(record), {
      contentType: "application/json; charset=utf-8",
      ifNoneMatch: "*",
    });

    return { slug, token, openPath: request.openPath };
  });
}

/** Publishes a new revision for an existing slug after token verification. */
function republishSite(
  storage: ObjectStorageShape,
  request: PublishRequest,
  user: AuthUser | null,
): Effect.Effect<PublishResult, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    const slug = request.slug;
    const token = request.token;
    if (slug == null || token == null) {
      return yield* Effect.fail(new SiteStoreError({ status: 400, message: "slug and token must be provided together" }));
    }
    const loaded = yield* loadSiteRecord(storage, slug);
    if (loaded == null) {
      return yield* Effect.fail(new SiteStoreError({ status: 404, message: "Slug not found" }));
    }
    const requestHash = yield* tokenHash(token);
    if (!timingSafeEqual(loaded.value.tokenHash, requestHash)) {
      return yield* Effect.fail(new SiteStoreError({ status: 403, message: "Invalid publish token" }));
    }

    const now = new Date().toISOString();
    const revision = yield* buildRevision(storage, slug, request, now);
    const record = siteRecord({
      slug,
      tokenHash: loaded.value.tokenHash,
      user: loaded.value.owner ?? ownerFromUser(user),
      createdAt: loaded.value.createdAt,
      updatedAt: now,
      revision,
    });

    yield* storage.putText(revisionRecordKey(slug, revision.revisionId), serialize(revision), {
      contentType: "application/json; charset=utf-8",
      ifNoneMatch: "*",
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StorageConflict
          ? new SiteStoreError({ status: 409, message: "Revision already exists", cause: error })
          : error,
      ),
    );
    yield* storage.putText(siteRecordKey(slug), serialize(record), {
      contentType: "application/json; charset=utf-8",
      ifMatch: loaded.etag,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StorageConflict
          ? new SiteStoreError({ status: 409, message: "Site was updated concurrently", cause: error })
          : error,
      ),
    );

    return { slug, token, openPath: request.openPath };
  });
}

/** Loads the current site record, revision, and SiteFiles provider. */
function loadPublishedSite(
  storage: ObjectStorageShape,
  slug: string,
): Effect.Effect<LoadedSite | null, SiteStoreError | StorageError> {
  return Effect.gen(function* () {
    if (!safeSlug(slug)) return null;
    const loaded = yield* loadSiteRecord(storage, slug);
    if (loaded == null) return null;
    const revision = yield* loadRevisionRecord(storage, loaded.value.slug, loaded.value.currentRevisionId);
    if (revision == null) {
      return yield* Effect.fail(
        new SiteStoreError({ status: 500, message: `Missing site revision: ${loaded.value.slug}` }),
      );
    }
    return {
      record: loaded.value,
      revision: revision.value,
      siteFiles: makeObjectSiteFiles(storage, revision.value),
    };
  });
}

/** Stores bundle files as content-addressed blobs and returns revision metadata. */
function buildRevision(
  storage: ObjectStorageShape,
  slug: string,
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

    return {
      version: 1,
      slug,
      revisionId: randomRevisionId(),
      createdAt,
      openPath: request.openPath,
      files,
    };
  });
}

/** Builds the metadata-only site pointer for a current revision. */
function siteRecord(input: {
  readonly slug: string;
  readonly tokenHash: string;
  readonly user: AuthUser | SiteOwner | null | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: SiteRevisionRecord;
}): SiteRecord {
  return {
    version: 2,
    slug: input.slug,
    tokenHash: input.tokenHash,
    owner: ownerFromUser(input.user),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currentRevisionId: input.revision.revisionId,
    currentOpenPath: input.revision.openPath,
    fileCount: input.revision.files.length,
    totalBytes: input.revision.files.reduce((total, file) => total + file.size, 0),
  };
}

/** Loads and validates the current site record. */
function loadSiteRecord(
  storage: ObjectStorageShape,
  slug: string,
): Effect.Effect<LoadedRecord<SiteRecord> | null, SiteStoreError | StorageError> {
  return loadJson(storage, siteRecordKey(slug), SiteRecordSchema);
}

/** Loads and validates one immutable revision record. */
function loadRevisionRecord(
  storage: ObjectStorageShape,
  slug: string,
  revisionId: string,
): Effect.Effect<LoadedRecord<SiteRevisionRecord> | null, SiteStoreError | StorageError> {
  return loadJson(storage, revisionRecordKey(slug, revisionId), SiteRevisionRecordSchema);
}

/** Loads one JSON object from storage and decodes it with a schema. */
function loadJson<A, I, R>(
  storage: ObjectStorageShape,
  key: string,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<LoadedRecord<A> | null, SiteStoreError | StorageError, R> {
  return Effect.gen(function* () {
    const object = yield* storage.getObject(key);
    if (object == null) return null;
    const parsed = parseJson(new TextDecoder().decode(object.body));
    if (!isRecord(parsed)) {
      return yield* Effect.fail(new SiteStoreError({ status: 500, message: `Invalid stored JSON: ${key}` }));
    }
    const value = yield* Schema.decodeUnknown(schema)(parsed, { errors: "all" }).pipe(
      Effect.mapError((error) =>
        new SiteStoreError({
          status: 500,
          message: `Invalid stored record ${key}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
        }),
      ),
    );
    return { value, etag: object.etag };
  });
}

/** Builds the object key for one mutable site pointer record. */
function siteRecordKey(slug: string): string {
  return `sites/${slug}/site.v2.json`;
}

/** Builds the object key for one immutable revision record. */
function revisionRecordKey(slug: string, revisionId: string): string {
  return `sites/${slug}/revisions/${revisionId}.json`;
}

/** Builds the object key for one content-addressed file blob. */
function blobObjectKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Serializes a storage record as compact JSON plus trailing newline. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Converts an optional auth user into persisted owner metadata. */
function ownerFromUser(user: AuthUser | SiteOwner | null | undefined): SiteOwner | undefined {
  if (user == null) return undefined;
  return { id: user.id, email: user.email };
}

/** Checks that revision metadata has no duplicate site paths. */
function uniquePaths(files: ReadonlyArray<{ readonly path: string }>): boolean {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) return false;
    paths.add(file.path);
  }
  return true;
}
