import type * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { SitePath } from "./paths";

export class SiteFileError extends Data.TaggedError("SiteFileError")<{
  readonly path: SitePath;
  readonly reason: "Forbidden" | "NotFound" | "ReadFailed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FileResponseOptions {
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

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
