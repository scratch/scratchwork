/*
 * The shared site-serving pipeline: parse the URL, resolve it against
 * SiteFiles (routing.ts), and turn the result into an HTTP response —
 * applying HTML transforms, renderer resolution, content types, and
 * cache-control policy. Consumers configure the variable parts through
 * SiteServeConfig; everything else is identical across the CLI dev server
 * and the deploy targets.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import { contentType, defaultCacheControl, isMarkdownPath } from "./content.ts";
import { SiteFileError, SiteFiles } from "./files.ts";
import { applyHtmlTransforms, type HtmlTransform } from "./html.ts";
import {
  resolveMarkdownRenderer,
  type MarkdownRenderer,
} from "./renderer.ts";
import {
  FAVICON_SVG_PATH,
  parseRouteRequest,
  resolveRoute,
  SiteRouteError,
  type ResolvedRoute,
} from "./routing.ts";

/** Which renderer shell answered a Markdown route, for logging/diagnostics. */
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

/** Notification that a request was served, emitted through onServeEvent. */
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

/** The consumer-supplied parts of the pipeline: transforms, fallback renderer, caching, events. */
export interface SiteServeConfig<E = never, R = never> {
  readonly htmlTransforms?: ReadonlyArray<HtmlTransform<E, R>>;
  readonly rendererFallback: Effect.Effect<string | null, E, R>;
  readonly defaultFaviconSvg?: string;
  readonly cacheControl?: (path: string) => string;
  readonly headers?: (path: string, contentType: string) => Record<string, string>;
  readonly pathPrefix?: string;
  readonly onServeEvent?: (
    event: SiteServeEvent,
  ) => Effect.Effect<void, E, SiteFiles | R>;
}

/** Serves an incoming HTTP request by extracting its pathname and query string. */
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

/**
 * Serves a pathname: routes it, builds the response, and maps routing-layer
 * failures (forbidden reads, malformed paths) to 403/400 responses.
 */
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

/** Turns a resolved route into its HTTP response, emitting serve events along the way. */
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
        return HttpServerResponse.redirect(prefixedLocation(route.location, config.pathPrefix), {
          status: route.status,
        });

      case "StaticHtml":
        yield* emit(config, { _tag: "StaticHtmlServed", path: route.path });
        return yield* htmlFileResponse(route.path, "static", config);

      case "StaticAsset": {
        const files = yield* SiteFiles;
        if (isMarkdownPath(route.path)) {
          yield* emit(config, { _tag: "RawMarkdownServed", path: route.path });
        }
        return yield* files.fileResponse(route.path, {
          contentType: contentType(route.path),
          headers: responseHeaders(route.path, contentType(route.path), config),
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
          headers: responseHeaders(FAVICON_SVG_PATH, "image/svg+xml", config),
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

/** Sends a serve event to the configured listener, if any. */
function emit<E, R>(
  config: SiteServeConfig<E, R>,
  event: SiteServeEvent,
): Effect.Effect<void, E, SiteFiles | R> {
  return config.onServeEvent ? config.onServeEvent(event) : Effect.void;
}

/** Summarizes a resolved renderer as an event-friendly RendererSource. */
function rendererSource(renderer: MarkdownRenderer | null): RendererSource {
  if (renderer == null) return { _tag: "None" };
  if (renderer._tag === "Project") {
    return { _tag: "Project", path: renderer.path };
  }
  return { _tag: "Fallback" };
}

/** Reads an HTML file from SiteFiles and serves it through the transform pipeline. */
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

/** Applies the configured HTML transforms and builds the final HTML response. */
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
      headers: responseHeaders(path, contentType(".html"), config),
    });
  });
}

/** Merges consumer headers with the cache-control policy for a path. */
function responseHeaders<E, R>(
  path: string,
  responseContentType: string,
  config: SiteServeConfig<E, R>,
): Record<string, string> {
  return {
    ...(config.headers ? config.headers(path, responseContentType) : {}),
    "Cache-Control": cacheControlFor(path, config),
  };
}

/** Picks the Cache-Control value: consumer override or the shared default policy. */
function cacheControlFor<E, R>(
  path: string,
  config: SiteServeConfig<E, R>,
): string {
  return config.cacheControl ? config.cacheControl(path) : defaultCacheControl(path);
}

/** Prepends the configured path prefix (e.g. "/myproject") to a redirect target. */
function prefixedLocation(location: string, pathPrefix: string | undefined): string {
  if (pathPrefix == null || pathPrefix === "" || pathPrefix === "/") return location;
  const prefix = `/${pathPrefix.replace(/^\/+|\/+$/g, "")}`;
  return `${prefix}${location.startsWith("/") ? location : `/${location}`}`;
}

/** The uniform 403 response for unsafe or forbidden paths. */
function forbiddenResponse(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text("Forbidden", {
    status: 403,
    contentType: "text/plain; charset=utf-8",
  });
}
