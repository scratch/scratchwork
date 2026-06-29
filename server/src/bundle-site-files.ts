import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { base64ToBytes, type PublishBundle } from "../../shared/src/publish/bundle";
import { contentType } from "../../shared/src/site/content";
import { SiteFileError, SiteFiles } from "../../shared/src/site/files";
import type { SitePath } from "../../shared/src/site/paths";

export function bundleSiteFilesLayer(bundle: PublishBundle): Layer.Layer<SiteFiles> {
  const files = new Map<SitePath, Uint8Array>();
  for (const file of bundle.files) {
    files.set(file.path, base64ToBytes(file.contentBase64));
  }

  return Layer.succeed(
    SiteFiles,
    SiteFiles.of({
      exists: (path) => Effect.succeed(files.has(path)),
      readText: (path) =>
        readBytes(files, path).pipe(
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
        ),
      readBytes: (path) => readBytes(files, path),
      fileResponse: (path, options) =>
        readBytes(files, path).pipe(
          Effect.map((bytes) =>
            HttpServerResponse.uint8Array(bytes, {
              contentType: options?.contentType ?? contentType(path),
              headers: options?.headers,
            }),
          ),
        ),
    }),
  );
}

function readBytes(
  files: ReadonlyMap<SitePath, Uint8Array>,
  path: SitePath,
): Effect.Effect<Uint8Array, SiteFileError> {
  const bytes = files.get(path);
  return bytes == null
    ? Effect.fail(
        new SiteFileError({
          path,
          reason: "NotFound",
          message: `File not found: ${path}`,
        }),
      )
    : Effect.succeed(bytes);
}
