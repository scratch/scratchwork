import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";
import { bytesToHex } from "../../../shared/src/encoding/hex";
import { isWithinRoot } from "../../../shared/src/util/fs";

/** Raised when a storage backend cannot complete a read or write. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Raised when an ifMatch/ifNoneMatch write precondition fails. */
export class StorageConflict extends Data.TaggedError("StorageConflict")<{
  readonly key: string;
  readonly message: string;
}> {}

/** One object read back from storage. */
export interface StoredObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly etag?: string;
}

/** Write options; `ifNoneMatch: "*"` requires the key to be new, `ifMatch` pins the current ETag. */
export interface PutObjectOptions {
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly ifNoneMatch?: "*";
  readonly ifMatch?: string;
}

/** Result of a successful write. */
export interface PutObjectResult {
  readonly etag?: string;
}

/** The blob-store contract every storage backend (local, S3, R2) must satisfy. */
export interface ObjectStorageShape {
  readonly getObject: (key: string) => Effect.Effect<StoredObject | null, StorageError>;
  readonly putObject: (
    key: string,
    value: Uint8Array,
    options?: PutObjectOptions,
  ) => Effect.Effect<PutObjectResult, StorageError | StorageConflict>;
  readonly putText: (
    key: string,
    value: string,
    options?: PutObjectOptions,
  ) => Effect.Effect<PutObjectResult, StorageError | StorageConflict>;
}

/** Service tag for the object storage backend. */
export class ObjectStorage extends Context.Tag("@scratchwork/server/ObjectStorage")<
  ObjectStorage,
  ObjectStorageShape
>() {}

/** Stores objects under a local directory using safe object keys. */
export function LocalObjectStorageLive(
  directory = ".scratchwork-data",
): Layer.Layer<ObjectStorage, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = paths.resolve(process.cwd(), directory);

      /** Resolves one object key to an absolute path under the storage root. */
      const resolveKey = (key: string): Effect.Effect<string, StorageError> =>
        Effect.gen(function* () {
          yield* requireSafeObjectKey(key);
          const absolute = paths.resolve(root, key);
          if (!isWithinRoot(absolute, root, paths.sep)) {
            return yield* Effect.fail(
              new StorageError({ message: `Object key escapes storage root: ${key}` }),
            );
          }
          return absolute;
        });

      /** Reads an existing object body for local conditional writes. */
      const readExisting = (path: string): Effect.Effect<Uint8Array | null, StorageError> =>
        fs.readFile(path).pipe(
          Effect.catchTags({
            SystemError: (error) =>
              isNotFound(error)
                ? Effect.succeed(null)
                : Effect.fail(new StorageError({ message: `Could not inspect object: ${path}`, cause: error })),
            BadArgument: (error) =>
              Effect.fail(new StorageError({ message: `Could not inspect object: ${path}`, cause: error })),
          }),
        );

      /** Reads one local object and computes its ETag; a missing file reads as null. */
      const getObject: ObjectStorageShape["getObject"] = (key) =>
        resolveKey(key).pipe(
          Effect.flatMap((path) =>
            fs.readFile(path).pipe(
              Effect.flatMap((body) =>
                sha256Hex(body).pipe(
                  Effect.map((etag) => ({ key, body, etag } satisfies StoredObject)),
                ),
              ),
              Effect.catchTags({
                SystemError: (error) =>
                  isNotFound(error)
                    ? Effect.succeed(null)
                    : Effect.fail(new StorageError({ message: `Could not read object: ${key}`, cause: error })),
                BadArgument: (error) =>
                  Effect.fail(new StorageError({ message: `Could not read object: ${key}`, cause: error })),
              }),
            ),
          ),
        );

      /** Writes one local object while honoring create/update preconditions. */
      const putObject: ObjectStorageShape["putObject"] = (key, value, options) =>
        resolveKey(key).pipe(
          Effect.flatMap((path) =>
            Effect.gen(function* () {
              const existing = yield* readExisting(path);
              if (options?.ifNoneMatch === "*" && existing != null) {
                return yield* Effect.fail(
                  new StorageConflict({ key, message: `Object already exists: ${key}` }),
                );
              }
              if (options?.ifMatch != null) {
                if (existing == null) {
                  return yield* Effect.fail(
                    new StorageConflict({ key, message: `Object does not exist: ${key}` }),
                  );
                }
                const existingEtag = yield* sha256Hex(existing);
                if (existingEtag !== options.ifMatch) {
                  return yield* Effect.fail(
                    new StorageConflict({ key, message: `Object ETag mismatch: ${key}` }),
                  );
                }
              }

              yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
              yield* fs.writeFile(path, value);
              return { etag: yield* sha256Hex(value) };
            }).pipe(
              Effect.catchTags({
                SystemError: (error) =>
                  Effect.fail(new StorageError({ message: `Could not write object: ${key}`, cause: error })),
                BadArgument: (error) =>
                  Effect.fail(new StorageError({ message: `Could not write object: ${key}`, cause: error })),
              }),
            ),
          ),
        );

      return ObjectStorage.of({
        getObject,
        putObject,
        putText: (key, value, options) => putObject(key, new TextEncoder().encode(value), options),
      });
    }),
  );
}

/** Fails when an object key can escape or confuse storage backends. */
export function requireSafeObjectKey(key: string): Effect.Effect<void, StorageError> {
  return safeObjectKey(key)
    ? Effect.void
    : Effect.fail(new StorageError({ message: `Invalid object key: ${key}` }));
}

/** Returns true for object-key syntax shared by local, S3, and R2 storage. */
export function safeObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("\0") &&
    key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Computes a SHA-256 digest as lowercase hex, used for ETags and content addressing. */
export function sha256Hex(bytes: Uint8Array): Effect.Effect<string, StorageError> {
  return Effect.tryPromise({
    try: async () => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)))),
    catch: (cause) => new StorageError({ message: "Could not hash bytes", cause }),
  });
}

/** Detects filesystem not-found system errors from Effect Platform. */
function isNotFound(error: { readonly reason: string }): boolean {
  return error.reason === "NotFound";
}
