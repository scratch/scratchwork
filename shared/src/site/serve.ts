import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { contentType, defaultCacheControl } from "./content";
import { SiteFileError, SiteFiles } from "./files";
import { applyHtmlTransforms, type HtmlTransform } from "./html";
import { nearestMarkdownRenderer } from "./renderer";
import {
  parseRouteRequest,
  resolveRoute,
  SiteRouteError,
  type ResolvedRoute,
} from "./routing";

export interface SiteServeConfig<E = never, R = never> {
  readonly htmlTransforms?: ReadonlyArray<HtmlTransform<E, R>>;
  readonly rendererFallback: Effect.Effect<string | null, E, R>;
  readonly defaultFaviconSvg?: string;
  readonly cacheControl?: (path: string) => string;
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
        return yield* htmlFileResponse(route.path, "static", config);

      case "StaticAsset": {
        const files = yield* SiteFiles;
        return yield* files.fileResponse(route.path, {
          contentType: contentType(route.path),
          headers: {
            "Cache-Control": cacheControlFor(route.path, config),
          },
        });
      }

      case "RenderedMarkdown": {
        const shell = yield* nearestMarkdownRenderer(
          route.rendererStartDir,
          config.rendererFallback,
        );
        if (shell == null) {
          return HttpServerResponse.text("No renderer shell available", {
            status: 500,
            contentType: "text/plain; charset=utf-8",
          });
        }
        return yield* htmlTextResponse(shell, route.markdownPath, "renderer", config);
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
