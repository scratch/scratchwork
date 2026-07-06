/*
 * URL-to-file routing for a site: how a request pathname maps onto the site's
 * files. Split into a pure planning step (routePlan — which files could
 * answer this URL) and a resolution step (resolveRoute — which of them
 * actually exists, via SiteFiles). Both the CLI dev server and the deploy
 * targets route through this module so URLs behave identically everywhere.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { extensionOf } from "./content";
import { SiteFileError, SiteFiles } from "./files";
import { isMarkedMarkdownRenderer } from "./marker";
import {
  basenameSitePath,
  dirnameSitePath,
  isSafeSitePath,
  joinSitePath,
  stripExtension,
  type SitePath,
} from "./paths";

/** The favicon a browser requests by default when a page names none. */
export const FAVICON_ICO_PATH = "favicon.ico";
/** The site file that suppresses the built-in default favicon (see serve.ts). */
export const FAVICON_SVG_PATH = "favicon.svg";

/** A request pathname that could not be parsed into a route. */
export class SiteRouteError extends Data.TaggedError("SiteRouteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A decoded, cleaned request: pathname plus the original query string. */
export interface RouteRequest {
  readonly pathname: string;
  readonly search?: string;
}

/** What a URL could map to, before checking which files exist. */
type RoutePlan =
  | {
      readonly _tag: "Redirect";
      readonly location: string;
      readonly status: 308;
    }
  | {
      readonly _tag: "DirectFile";
      readonly path: SitePath;
    }
  | {
      readonly _tag: "RawMarkdown";
      readonly candidates: ReadonlyArray<SitePath>;
    }
  | {
      readonly _tag: "Page";
      readonly htmlCandidates: ReadonlyArray<SitePath>;
      readonly markdownCandidates: ReadonlyArray<MarkdownCandidate>;
      /** The exact extensionless file, tried last so files like LICENSE stay reachable. */
      readonly directPath?: SitePath;
      /** Where to 308 when a directory index answers a slash-less URL, so relative links resolve. */
      readonly indexRedirect?: string;
    }
  | {
      readonly _tag: "Forbidden";
    };

/** A Markdown file that could answer a page URL, and where its renderer lookup starts. */
interface MarkdownCandidate {
  readonly path: SitePath;
  readonly rendererStartDir: SitePath;
}

/** The final routing decision after checking the site's files. */
export type ResolvedRoute =
  | {
      readonly _tag: "Redirect";
      readonly location: string;
      readonly status: 308;
    }
  | {
      readonly _tag: "StaticHtml";
      readonly path: SitePath;
    }
  | {
      readonly _tag: "StaticAsset";
      readonly path: SitePath;
    }
  | {
      readonly _tag: "RenderedMarkdown";
      readonly markdownPath: SitePath;
      readonly rendererStartDir: SitePath;
    }
  | {
      readonly _tag: "DefaultFavicon";
    }
  | {
      readonly _tag: "NotFound";
    }
  | {
      readonly _tag: "Forbidden";
    };

/** Decodes and cleans a raw request path, failing on malformed percent-encoding. */
export function parseRouteRequest(
  pathname: string,
  search = "",
): Effect.Effect<RouteRequest, SiteRouteError> {
  return Effect.try({
    try: () => ({
      pathname: cleanPathname(decodeURIComponent(pathname)),
      search,
    }),
    catch: (cause) =>
      new SiteRouteError({
        message: `Invalid request path: ${pathname}`,
        cause,
      }),
  });
}

/**
 * Pure routing policy: maps a request onto candidate files without touching
 * storage. Explicit .html URLs redirect to their extensionless form, .md URLs
 * serve raw Markdown, other extensions serve the file directly, and
 * extensionless "page" URLs try HTML, then rendered Markdown, then the exact
 * file. Slash-less URLs answered by a directory index redirect to the
 * trailing-slash form first.
 */
function routePlan(request: RouteRequest): RoutePlan {
  const pathname = cleanPathname(request.pathname);
  const search = request.search ?? "";
  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const last = pathname.split("/").pop() ?? "";

  if (last.endsWith(".html")) {
    if (!rel || !isSafeSitePath(rel)) return { _tag: "Forbidden" };
    return {
      _tag: "Redirect",
      location: canonicalHtmlLocation(pathname, search),
      status: 308,
    };
  }

  if (last.includes(".")) {
    const directPath = pathname.replace(/^\/+/, "");
    if (!isSafeSitePath(directPath)) return { _tag: "Forbidden" };

    if (extensionOf(directPath) === ".md") {
      const candidates = [directPath];
      if (basenameSitePath(directPath) !== "index.md") {
        candidates.push(joinSitePath(stripExtension(directPath, ".md"), "index.md"));
      }
      return { _tag: "RawMarkdown", candidates };
    }

    return { _tag: "DirectFile", path: directPath };
  }

  const dirStyle = pathname === "/" || pathname.endsWith("/");
  const route = rel;
  const htmlCandidates = dirStyle
    ? [joinSitePath(route, "index.html")]
    : [`${route}.html`, joinSitePath(route, "index.html")];
  const markdownCandidates = dirStyle
    ? [
        {
          path: joinSitePath(route, "index.md"),
          rendererStartDir: route,
        },
      ]
    : [
        {
          path: `${route}.md`,
          rendererStartDir: dirnameSitePath(`${route}.md`),
        },
        {
          path: joinSitePath(route, "index.md"),
          rendererStartDir: route,
        },
      ];
  const directPath = dirStyle ? undefined : route;

  if (
    !htmlCandidates.every(isSafeSitePath) ||
    !markdownCandidates.every(({ path }) => isSafeSitePath(path)) ||
    (directPath != null && !isSafeSitePath(directPath))
  ) {
    return { _tag: "Forbidden" };
  }

  return {
    _tag: "Page",
    htmlCandidates,
    markdownCandidates,
    directPath,
    indexRedirect: dirStyle ? undefined : `${encodePathname(pathname)}/${search}`,
  };
}

/**
 * Resolves a request to a concrete outcome by checking which planned
 * candidates exist in SiteFiles. A marked renderer index.html is skipped as
 * static HTML so the Markdown candidates behind it can win.
 */
export function resolveRoute(
  request: RouteRequest,
): Effect.Effect<ResolvedRoute, SiteFileError, SiteFiles> {
  return Effect.gen(function* () {
    const files = yield* SiteFiles;
    const plan = routePlan(request);

    switch (plan._tag) {
      case "Forbidden":
        return { _tag: "Forbidden" };

      case "Redirect":
        return plan;

      case "DirectFile": {
        if (yield* files.exists(plan.path)) {
          return { _tag: "StaticAsset", path: plan.path };
        }
        if (
          plan.path === FAVICON_ICO_PATH &&
          !(yield* files.exists(FAVICON_SVG_PATH))
        ) {
          return { _tag: "DefaultFavicon" };
        }
        return { _tag: "NotFound" };
      }

      case "RawMarkdown": {
        for (const path of plan.candidates) {
          if (yield* files.exists(path)) {
            return { _tag: "StaticAsset", path };
          }
        }
        return { _tag: "NotFound" };
      }

      case "Page": {
        for (const path of plan.htmlCandidates) {
          if (yield* files.exists(path)) {
            const html = yield* files.readText(path);
            if (!isMarkedMarkdownRenderer(html)) {
              if (plan.indexRedirect != null && basenameSitePath(path) === "index.html") {
                return { _tag: "Redirect", location: plan.indexRedirect, status: 308 };
              }
              return { _tag: "StaticHtml", path };
            }
          }
        }
        for (const candidate of plan.markdownCandidates) {
          if (yield* files.exists(candidate.path)) {
            if (plan.indexRedirect != null && basenameSitePath(candidate.path) === "index.md") {
              return { _tag: "Redirect", location: plan.indexRedirect, status: 308 };
            }
            return {
              _tag: "RenderedMarkdown",
              markdownPath: candidate.path,
              rendererStartDir: candidate.rendererStartDir,
            };
          }
        }
        if (plan.directPath != null && (yield* files.exists(plan.directPath))) {
          return { _tag: "StaticAsset", path: plan.directPath };
        }
        return { _tag: "NotFound" };
      }
    }
  });
}

/** Collapses repeated slashes in a URL pathname and ensures a leading slash. */
function cleanPathname(pathname: string): string {
  const clean = pathname.replace(/\/{2,}/g, "/");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/** Percent-encodes a decoded pathname's segments so it is safe in a Location header. */
function encodePathname(pathname: string): string {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

/** Computes the extensionless redirect target for an explicit .html URL. */
function canonicalHtmlLocation(pathname: string, search: string): string {
  if (pathname === "/index.html") return `/${search}`;
  if (pathname.endsWith("/index.html")) {
    return `${encodePathname(pathname.slice(0, -"index.html".length))}${search}`;
  }
  return `${encodePathname(pathname.slice(0, -".html".length))}${search}`;
}
