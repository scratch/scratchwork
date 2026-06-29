import { ObjectStorage, StorageError, safeObjectKey } from "@scratchwork/server-core/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface R2BucketBinding {
  readonly get: (key: string) => Promise<R2ObjectBodyBinding | null>;
  readonly put: (
    key: string,
    value: string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ) => Promise<unknown>;
}

interface R2ObjectBodyBinding {
  readonly text: () => Promise<string>;
}

export function R2ObjectStorageLive(bucket: R2BucketBinding): Layer.Layer<ObjectStorage> {
  return Layer.succeed(
    ObjectStorage,
    ObjectStorage.of({
      getText: (key) =>
        validateKey(key).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: async () => (await bucket.get(key))?.text() ?? null,
              catch: (cause) => new StorageError({ message: `Could not read object: ${key}`, cause }),
            }),
          ),
        ),

      putText: (key, value) =>
        validateKey(key).pipe(
          Effect.zipRight(
            Effect.tryPromise({
              try: async () => {
                await bucket.put(key, value, {
                  httpMetadata: { contentType: "application/json; charset=utf-8" },
                });
              },
              catch: (cause) => new StorageError({ message: `Could not write object: ${key}`, cause }),
            }),
          ),
        ),
    }),
  );
}

function validateKey(key: string): Effect.Effect<void, StorageError> {
  return safeObjectKey(key)
    ? Effect.void
    : Effect.fail(new StorageError({ message: `Invalid object key: ${key}` }));
}
