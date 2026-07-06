/*
 * The SiteFiles service: the abstraction over "where a site's files live"
 * that the routing and serving layers are written against. The CLI backs it
 * with the local filesystem; deploy targets back it with S3, R2, or bundled
 * assets — routing logic stays identical everywhere.
 */
import type * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { SitePath } from "./paths";

/** Failure reading a site file, tagged with why (forbidden, missing, or IO error). */
export class SiteFileError extends Data.TaggedError("SiteFileError")<{
  readonly path: SitePath;
  readonly reason: "Forbidden" | "NotFound" | "ReadFailed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Overrides for the response a SiteFiles implementation builds from a file. */
export interface FileResponseOptions {
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/** Read access to a site's files, keyed by site-relative path. */
export class SiteFiles extends Context.Tag("@scratchwork/site/SiteFiles")<
  SiteFiles,
  {
    readonly exists: (path: SitePath) => Effect.Effect<boolean, SiteFileError>;
    readonly readText: (path: SitePath) => Effect.Effect<string, SiteFileError>;
    readonly readBytes: (path: SitePath) => Effect.Effect<Uint8Array, SiteFileError>;
    readonly fileResponse: (
      path: SitePath,
      options?: FileResponseOptions,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, SiteFileError>;
  }
>() {}
