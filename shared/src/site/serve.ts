import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { contentType, defaultCacheControl } from "./content";
import { SiteFileError, SiteFiles } from "./files";
import { applyHtmlTransforms, type HtmlTransform } from "./html";
import {
  resolveMarkdownRenderer,
  type MarkdownRenderer,
} from "./renderer";
import {
  parseRouteRequest,
  resolveRoute,
  SiteRouteError,
  type ResolvedRoute,
} from "./routing";

export type RendererSource =
  | {
      readonly _tag: "Project";
      readonly path: string;
    }
  | {
      readonly _tag: "Fallback";
    }
  | {
      readonly _tag: "None";
    };

export type SiteServeEvent =
  | {
      readonly _tag: "StaticHtmlServed";
      readonly path: string;
    }
  | {
      readonly _tag: "RawMarkdownServed";
      readonly path: string;
    }
  | {
      readonly _tag: "RenderedMarkdownServed";
      readonly markdownPath: string;
      readonly renderer: RendererSource;
      readonly rendererHtml?: string;
    };

export interface SiteServeConfig<E = never, R = never> {
  readonly htmlTransforms?: ReadonlyArray<HtmlTransform<E, R>>;
  readonly rendererFallback: Effect.Effect<string | null, E, R>;
  readonly defaultFaviconSvg?: string;
  readonly cacheControl?: (path: string) => string;
  readonly onServeEvent?: (
    event: SiteServeEvent,
  ) => Effect.Effect<void, E, SiteFiles | R>;
}

export function serveRequest<E, R>(
  request: HttpServerRequest.HttpServerRequest,
  config: SiteServeConfig<E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | SiteFileError,
  SiteFiles | R
> {
  const url = new URL(request.url, "http://scratchwork.local");
  return servePath(url.pathname, url.search, config);
}

export function servePath<E, R>(
  pathname: string,
  search: string,
  config: SiteServeConfig<E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | SiteFileError,
  SiteFiles | R
> {
  return Effect.gen(function* () {
    const request = yield* parseRouteRequest(pathname, search);
    const route = yield* resolveRoute(request);
    return yield* respond(route, request.pathname, config);
  }).pipe(
    Effect.catchAll((error) => {
      if (error instanceof SiteFileError && error.reason === "Forbidden") {
        return Effect.succeed(forbiddenResponse());
      }
      if (error instanceof SiteRouteError) {
        return Effect.succeed(
          HttpServerResponse.text(error.message, {
            status: 400,
            contentType: "text/plain; charset=utf-8",
          }),
        );
      }
      return Effect.fail(error as E | SiteFileError);
    }),
  );
}

function respond<E, R>(
  route: ResolvedRoute,
  pathname: string,
  config: SiteServeConfig<E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | SiteFileError,
  SiteFiles | R
> {
  return Effect.gen(function* () {
    switch (route._tag) {
      case "Redirect":
        return HttpServerResponse.redirect(route.location, {
          status: route.status,
        });

      case "StaticHtml":
        yield* emit(config, { _tag: "StaticHtmlServed", path: route.path });
        return yield* htmlFileResponse(route.path, "static", config);

      case "StaticAsset": {
        const files = yield* SiteFiles;
        if (contentType(route.path) === contentType(".md")) {
          yield* emit(config, { _tag: "RawMarkdownServed", path: route.path });
        }
        return yield* files.fileResponse(route.path, {
          contentType: contentType(route.path),
          headers: {
            "Cache-Control": cacheControlFor(route.path, config),
          },
        });
      }

      case "RenderedMarkdown": {
        const renderer = yield* resolveMarkdownRenderer(
          route.rendererStartDir,
          config.rendererFallback,
        );
        yield* emit(config, {
          _tag: "RenderedMarkdownServed",
          markdownPath: route.markdownPath,
          renderer: rendererSource(renderer),
          rendererHtml: renderer?.html,
        });
        if (renderer == null) {
          return HttpServerResponse.text("No renderer shell available", {
            status: 500,
            contentType: "text/plain; charset=utf-8",
          });
        }
        return yield* htmlTextResponse(
          renderer.html,
          route.markdownPath,
          "renderer",
          config,
        );
      }

      case "DefaultFavicon":
        return HttpServerResponse.text(config.defaultFaviconSvg ?? "", {
          contentType: "image/svg+xml",
          headers: {
            "Cache-Control": cacheControlFor("favicon.svg", config),
          },
        });

      case "Forbidden":
        return forbiddenResponse();

      case "NotFound":
        return HttpServerResponse.text(`Not found: ${pathname}`, {
          status: 404,
          contentType: "text/plain; charset=utf-8",
        });
    }
  });
}

function emit<E, R>(
  config: SiteServeConfig<E, R>,
  event: SiteServeEvent,
): Effect.Effect<void, E, SiteFiles | R> {
  return config.onServeEvent ? config.onServeEvent(event) : Effect.void;
}

function rendererSource(renderer: MarkdownRenderer | null): RendererSource {
  if (renderer == null) return { _tag: "None" };
  if (renderer._tag === "Project") {
    return { _tag: "Project", path: renderer.path };
  }
  return { _tag: "Fallback" };
}

function htmlFileResponse<E, R>(
  path: string,
  kind: "static" | "renderer",
  config: SiteServeConfig<E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | SiteFileError,
  SiteFiles | R
> {
  return Effect.gen(function* () {
    const files = yield* SiteFiles;
    const html = yield* files.readText(path);
    return yield* htmlTextResponse(html, path, kind, config);
  });
}

function htmlTextResponse<E, R>(
  html: string,
  path: string,
  kind: "static" | "renderer",
  config: SiteServeConfig<E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> {
  return Effect.gen(function* () {
    const transformed = yield* applyHtmlTransforms(html, { path, kind }, config.htmlTransforms ?? []);
    return HttpServerResponse.text(transformed, {
      contentType: contentType(".html"),
      headers: {
        "Cache-Control": cacheControlFor(path, config),
      },
    });
  });
}

function cacheControlFor<E, R>(
  path: string,
  config: SiteServeConfig<E, R>,
): string {
  return config.cacheControl ? config.cacheControl(path) : defaultCacheControl(path);
}

function forbiddenResponse(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text("Forbidden", {
    status: 403,
    contentType: "text/plain; charset=utf-8",
  });
}
