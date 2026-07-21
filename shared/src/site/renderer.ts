/*
 * Resolution of the renderer shell for a Markdown page: the nearest marked
 * index.html up the directory tree wins, otherwise the consumer-provided
 * fallback shell (the one embedded in the CLI/server) is used.
 */
import * as Effect from "effect/Effect";
import { SiteFileError, SiteFiles } from "./files.ts";
import { isMarkedMarkdownRenderer } from "./marker.ts";
import { dirnameSitePath, joinSitePath, type SitePath } from "./paths.ts";

/** The renderer shell to serve for a Markdown route, and where it came from. */
export type MarkdownRenderer =
  | {
      readonly _tag: "Project";
      readonly path: SitePath;
      readonly html: string;
    }
  | {
      readonly _tag: "Fallback";
      readonly html: string;
    };

/**
 * Finds the renderer shell for a Markdown file: walks from startDir to the
 * site root looking for a marked index.html, then falls back to the provided
 * shell. Returns null when neither exists.
 */
export function resolveMarkdownRenderer<E, R>(
  startDir: SitePath,
  fallback: Effect.Effect<string | null, E, R>,
): Effect.Effect<MarkdownRenderer | null, E | SiteFileError, SiteFiles | R> {
  return Effect.gen(function* () {
    const files = yield* SiteFiles;
    let current = startDir;

    while (true) {
      const candidate = joinSitePath(current, "index.html");
      if (yield* files.exists(candidate)) {
        const html = yield* files.readText(candidate);
        if (isMarkedMarkdownRenderer(html)) {
          return { _tag: "Project", path: candidate, html };
        }
      }
      if (current === "") break;
      const parent = dirnameSitePath(current);
      if (parent === current) break;
      current = parent;
    }

    const html = yield* fallback;
    return html == null ? null : { _tag: "Fallback", html };
  });
}
