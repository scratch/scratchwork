import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export function LocalObjectStorageLive(
  directory = ".scratchwork-data",
): Layer.Layer<ObjectStorage, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(
    ObjectStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = paths.resolve(process.cwd(), directory);

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
    }),
  );
}

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

function isNotFound(error: PlatformError): boolean {
  return error._tag === "SystemError" && error.reason === "NotFound";
}
