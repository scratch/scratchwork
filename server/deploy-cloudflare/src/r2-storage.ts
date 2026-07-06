import { ObjectStorage, StorageConflict, StorageError, requireSafeObjectKey, type ObjectStorageShape } from "@scratchwork/server-core/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The subset of Cloudflare's R2 bucket binding the adapter uses. */
export interface R2BucketBinding {
  readonly get: (key: string) => Promise<R2ObjectBodyBinding | null>;
  readonly put: (
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string; readonly cacheControl?: string };
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ) => Promise<R2ObjectBinding | null>;
}

/** An R2 object with a readable body. */
interface R2ObjectBodyBinding {
  readonly etag?: string;
  readonly httpEtag?: string;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly text: () => Promise<string>;
}

/** R2 write-result metadata. */
interface R2ObjectBinding {
  readonly etag?: string;
  readonly httpEtag?: string;
}

/** Adapts a Cloudflare R2 bucket binding to the server object storage contract. */
export function R2ObjectStorageLive(bucket: R2BucketBinding): Layer.Layer<ObjectStorage> {
  const getObject: ObjectStorageShape["getObject"] = (key) =>
    requireSafeObjectKey(key).pipe(
      Effect.zipRight(
        Effect.tryPromise({
          try: async () => {
            const object = await bucket.get(key);
            return object == null
              ? null
              : {
                  key,
                  body: new Uint8Array(await object.arrayBuffer()),
                  contentType: object.httpMetadata?.contentType,
                  etag: object.etag ?? object.httpEtag,
                };
          },
          catch: (cause) => new StorageError({ message: `Could not read object: ${key}`, cause }),
        }),
      ),
    );

  const putObject: ObjectStorageShape["putObject"] = (key, value, options) =>
    requireSafeObjectKey(key).pipe(
      Effect.zipRight(
        Effect.gen(function* () {
          // R2's onlyIf preconditions are advisory in some runtimes, so check explicitly
          // first; the onlyIf clause below keeps the write itself conditional too.
          if (options?.ifNoneMatch === "*" || options?.ifMatch != null) {
            const existing = yield* Effect.tryPromise({
              try: () => bucket.get(key),
              catch: (cause) => new StorageError({ message: `Could not write object: ${key}`, cause }),
            });
            if (options.ifNoneMatch === "*" && existing != null) {
              return yield* Effect.fail(new StorageConflict({ key, message: `Object already exists: ${key}` }));
            }
            if (options.ifMatch != null && (existing == null || existing.etag !== options.ifMatch)) {
              return yield* Effect.fail(new StorageConflict({ key, message: `Object ETag mismatch: ${key}` }));
            }
          }
          const result = yield* Effect.tryPromise({
            try: () =>
              bucket.put(key, value, {
                httpMetadata: {
                  contentType: options?.contentType,
                  cacheControl: options?.cacheControl,
                },
                onlyIf: options?.ifMatch != null
                  ? { etagMatches: options.ifMatch }
                  : options?.ifNoneMatch === "*"
                    ? { etagDoesNotMatch: "*" }
                    : undefined,
              }),
            catch: (cause) => new StorageError({ message: `Could not write object: ${key}`, cause }),
          });
          if (result == null) {
            return yield* Effect.fail(new StorageConflict({ key, message: `Object write precondition failed: ${key}` }));
          }
          return { etag: result.etag ?? result.httpEtag };
        }),
      ),
    );

  return Layer.succeed(
    ObjectStorage,
    ObjectStorage.of({
      getObject,
      putObject,
      putText: (key, value, options) => putObject(key, new TextEncoder().encode(value), options),
    }),
  );
}
