import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig, type StorageConfig } from "./config";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ObjectStorageShape {
  readonly getText: (key: string) => Effect.Effect<string | null, StorageError>;
  readonly putText: (key: string, value: string) => Effect.Effect<void, StorageError>;
}

export class ObjectStorage extends Context.Tag("@scratchwork/server/ObjectStorage")<
  ObjectStorage,
  ObjectStorageShape
>() {}

export const ObjectStorageLive: Layer.Layer<
  ObjectStorage,
  never,
  ServerConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  ObjectStorage,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return config.storage._tag === "Local"
      ? yield* localObjectStorage(config.storage)
      : s3ObjectStorage(config.storage);
  }),
);

function localObjectStorage(
  config: Extract<StorageConfig, { readonly _tag: "Local" }>,
): Effect.Effect<ObjectStorageShape, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = paths.resolve(process.cwd(), config.directory);

    const resolveKey = (key: string): Effect.Effect<string, StorageError> =>
      Effect.gen(function* () {
        if (!safeObjectKey(key)) {
          return yield* Effect.fail(
            new StorageError({ message: `Invalid object key: ${key}` }),
          );
        }
        const absolute = paths.resolve(root, key);
        if (absolute !== root && !absolute.startsWith(root + paths.sep)) {
          return yield* Effect.fail(
            new StorageError({ message: `Object key escapes storage root: ${key}` }),
          );
        }
        return absolute;
      });

    return ObjectStorage.of({
      getText: (key) =>
        resolveKey(key).pipe(
          Effect.flatMap((path) => fs.readFileString(path)),
          Effect.map((value) => value as string | null),
          Effect.catchAll((error) =>
            error instanceof StorageError
              ? Effect.fail(error)
              : isNotFound(error)
                ? Effect.succeed(null)
                : Effect.fail(
                    new StorageError({
                      message: `Could not read object: ${key}`,
                      cause: error,
                    }),
                  ),
          ),
        ),

      putText: (key, value) =>
        resolveKey(key).pipe(
          Effect.flatMap((path) =>
            fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(
              Effect.zipRight(fs.writeFileString(path, value)),
            ),
          ),
          Effect.mapError((error) =>
            error instanceof StorageError
              ? error
              : new StorageError({
                  message: `Could not write object: ${key}`,
                  cause: error,
                }),
          ),
        ),
    });
  });
}

function s3ObjectStorage(
  config: Extract<StorageConfig, { readonly _tag: "S3" }>,
): ObjectStorageShape {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });

  return ObjectStorage.of({
    getText: (key) =>
      Effect.tryPromise({
        try: async () => {
          const response = await client.send(
            new GetObjectCommand({
              Bucket: config.bucket,
              Key: key,
            }),
          );
          return response.Body == null ? null : await response.Body.transformToString("utf-8");
        },
        catch: (cause) =>
          isS3NotFound(cause)
            ? new StorageError({ message: "not found", cause })
            : new StorageError({ message: `Could not read object: ${key}`, cause }),
      }).pipe(
        Effect.catchAll((error) =>
          error.message === "not found" ? Effect.succeed(null) : Effect.fail(error),
        ),
      ),

    putText: (key, value) =>
      Effect.tryPromise({
        try: async () => {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: key,
              Body: value,
              ContentType: "application/json; charset=utf-8",
            }),
          );
        },
        catch: (cause) =>
          new StorageError({ message: `Could not write object: ${key}`, cause }),
      }),
  });
}

function safeObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("\0") &&
    key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isNotFound(error: PlatformError): boolean {
  return error._tag === "SystemError" && error.reason === "NotFound";
}

function isS3NotFound(cause: unknown): boolean {
  if (cause instanceof NoSuchKey) return true;
  const candidate = cause as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
