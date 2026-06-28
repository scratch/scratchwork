import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { extensionOf } from "./content";
import { SiteFileError, SiteFiles } from "./files";
import { isMarkedMarkdownRenderer } from "./marker";
import {
  basenameSitePath,
  cleanPathname,
  dirnameSitePath,
  isSafeSitePath,
  joinSitePath,
  stripExtension,
  type SitePath,
} from "./paths";

export class SiteRouteError extends Data.TaggedError("SiteRouteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RouteRequest {
  readonly pathname: string;
  readonly search?: string;
}

export type RoutePlan =
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
    }
  | {
      readonly _tag: "Forbidden";
    };

export interface MarkdownCandidate {
  readonly path: SitePath;
  readonly rendererStartDir: SitePath;
}

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

export function routePlan(request: RouteRequest): RoutePlan {
  const pathname = cleanPathname(request.pathname);
  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const last = pathname.split("/").pop() ?? "";

  if (last.endsWith(".html")) {
    if (!rel || !isSafeSitePath(rel)) return { _tag: "Forbidden" };
    return {
      _tag: "Redirect",
      location: canonicalHtmlLocation(pathname, request.search ?? ""),
      status: 308,
    };
  }

  if (last.includes(".")) {
    const directPath = pathname.replace(/^\/+/, "") as SitePath;
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
  const route = rel as SitePath;
  const htmlCandidates = dirStyle
    ? [joinSitePath(route, "index.html")]
    : [(`${route}.html`) as SitePath, joinSitePath(route, "index.html")];
  const markdownCandidates = dirStyle
    ? [
        {
          path: joinSitePath(route, "index.md"),
          rendererStartDir: route,
        },
      ]
    : [
        {
          path: (`${route}.md`) as SitePath,
          rendererStartDir: dirnameSitePath((`${route}.md`) as SitePath),
        },
        {
          path: joinSitePath(route, "index.md"),
          rendererStartDir: route,
        },
      ];

  if (
    !htmlCandidates.every(isSafeSitePath) ||
    !markdownCandidates.every(({ path }) => isSafeSitePath(path))
  ) {
    return { _tag: "Forbidden" };
  }

  return {
    _tag: "Page",
    htmlCandidates,
    markdownCandidates,
  };
}

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
          plan.path === "favicon.ico" &&
          !(yield* files.exists("favicon.svg"))
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
              return { _tag: "StaticHtml", path };
            }
          }
        }
        for (const candidate of plan.markdownCandidates) {
          if (yield* files.exists(candidate.path)) {
            return {
              _tag: "RenderedMarkdown",
              markdownPath: candidate.path,
              rendererStartDir: candidate.rendererStartDir,
            };
          }
        }
        return { _tag: "NotFound" };
      }
    }
  });
}

function canonicalHtmlLocation(pathname: string, search: string): string {
  if (pathname === "/index.html") return `/${search}`;
  if (pathname.endsWith("/index.html")) {
    return `${pathname.slice(0, -"index.html".length)}${search}`;
  }
  return `${pathname.slice(0, -".html".length)}${search}`;
}
