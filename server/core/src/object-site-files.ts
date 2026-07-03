import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { contentType } from "../../../shared/src/site/content";
import { SiteFileError, SiteFiles } from "../../../shared/src/site/files";
import type { SitePath } from "../../../shared/src/site/paths";
import type { SiteRevisionRecord } from "./site-records";
import type { ObjectStorageShape } from "./storage";

/** Builds a SiteFiles service backed by revision metadata and object storage. */
export function makeObjectSiteFiles(
  storage: ObjectStorageShape,
  revision: SiteRevisionRecord,
) {
  const files = new Map<SitePath, SiteRevisionRecord["files"][number]>();
  for (const file of revision.files) {
    files.set(file.path, file);
  }

  /** Reads one published file blob by site path. */
  const readBytes = (path: SitePath): Effect.Effect<Uint8Array, SiteFileError> => {
    const file = files.get(path);
    if (file == null) {
      return Effect.fail(
        new SiteFileError({
          path,
          reason: "NotFound",
          message: `File not found: ${path}`,
        }),
      );
    }

    return storage.getObject(file.objectKey).pipe(
      Effect.flatMap((object) =>
        object == null
          ? Effect.fail(
              new SiteFileError({
                path,
                reason: "ReadFailed",
                message: `Published blob not found: ${path}`,
              }),
            )
          : Effect.succeed(object.body),
      ),
      Effect.mapError((error) =>
        error instanceof SiteFileError
          ? error
          : new SiteFileError({
              path,
              reason: "ReadFailed",
              message: `Could not read published file: ${path}`,
              cause: error,
            }),
      ),
    );
  };

  return SiteFiles.of({
    exists: (path) => Effect.succeed(files.has(path)),
    readBytes,
    readText: (path) => readBytes(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    fileResponse: (path, options) =>
      readBytes(path).pipe(
        Effect.map((bytes) =>
          HttpServerResponse.uint8Array(bytes, {
            contentType: options?.contentType ?? files.get(path)?.contentType ?? contentType(path),
            headers: options?.headers,
          }),
        ),
      ),
  });
}
