import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as HttpPlatform from "@effect/platform/HttpPlatform";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SiteFileError, SiteFiles } from "../../../shared/src/site/files";
import type { SitePath } from "../../../shared/src/site/paths";

export function layer(
  root: string,
): Layer.Layer<
  SiteFiles,
  never,
  FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path
> {
  return Layer.effect(
    SiteFiles,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const httpPlatform = yield* HttpPlatform.HttpPlatform;
      const paths = yield* Path.Path;
      const resolvedRoot = paths.resolve(root);

      const resolvePath = (sitePath: SitePath): Effect.Effect<string, SiteFileError> =>
        Effect.gen(function* () {
          if (
            sitePath.startsWith("/") ||
            sitePath.includes("\\") ||
            sitePath.includes("\0")
          ) {
            return yield* Effect.fail(
              new SiteFileError({
                path: sitePath,
                reason: "Forbidden",
                message: `Invalid site path: ${sitePath}`,
              }),
            );
          }

          const absolutePath = paths.resolve(resolvedRoot, sitePath);
          if (
            absolutePath !== resolvedRoot &&
            !absolutePath.startsWith(resolvedRoot + paths.sep)
          ) {
            return yield* Effect.fail(
              new SiteFileError({
                path: sitePath,
                reason: "Forbidden",
                message: `Path escapes site root: ${sitePath}`,
              }),
            );
          }
          return absolutePath;
        });

      const mapReadError = (sitePath: SitePath, error: PlatformError) =>
        new SiteFileError({
          path: sitePath,
          reason: isNotFound(error) ? "NotFound" : "ReadFailed",
          message: isNotFound(error)
            ? `File not found: ${sitePath}`
            : `Could not read file: ${sitePath}`,
          cause: error,
        });

      return SiteFiles.of({
        exists: (sitePath) =>
          resolvePath(sitePath).pipe(
            Effect.flatMap((absolutePath) => fs.stat(absolutePath)),
            Effect.map((info) => info.type === "File"),
            Effect.catchAll((error) =>
              error instanceof SiteFileError
                ? error.reason === "NotFound"
                  ? Effect.succeed(false)
                  : Effect.fail(error)
                : isNotFound(error)
                  ? Effect.succeed(false)
                  : Effect.fail(mapReadError(sitePath, error)),
            ),
          ),

        readText: (sitePath) =>
          resolvePath(sitePath).pipe(
            Effect.flatMap((absolutePath) => fs.readFileString(absolutePath)),
            Effect.catchAll((error) =>
              error instanceof SiteFileError
                ? Effect.fail(error)
                : Effect.fail(mapReadError(sitePath, error)),
            ),
          ),

        readBytes: (sitePath) =>
          resolvePath(sitePath).pipe(
            Effect.flatMap((absolutePath) => fs.readFile(absolutePath)),
            Effect.catchAll((error) =>
              error instanceof SiteFileError
                ? Effect.fail(error)
                : Effect.fail(mapReadError(sitePath, error)),
            ),
          ),

        fileResponse: (sitePath, options) =>
          resolvePath(sitePath).pipe(
            Effect.flatMap((absolutePath) =>
              HttpServerResponse.file(absolutePath, options).pipe(
                Effect.provideService(HttpPlatform.HttpPlatform, httpPlatform),
              ),
            ),
            Effect.catchAll((error) =>
              error instanceof SiteFileError
                ? Effect.fail(error)
                : Effect.fail(mapReadError(sitePath, error)),
            ),
          ),
      });
    }),
  );
}

function isNotFound(error: PlatformError): boolean {
  return error._tag === "SystemError" && error.reason === "NotFound";
}
