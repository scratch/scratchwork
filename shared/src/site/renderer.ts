import * as Effect from "effect/Effect";
import { SiteFileError, SiteFiles } from "./files";
import { isMarkedMarkdownRenderer } from "./marker";
import { dirnameSitePath, joinSitePath, type SitePath } from "./paths";

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

export function nearestMarkdownRenderer<E, R>(
  startDir: SitePath,
  fallback: Effect.Effect<string | null, E, R>,
): Effect.Effect<string | null, E | SiteFileError, SiteFiles | R> {
  return resolveMarkdownRenderer(startDir, fallback).pipe(
    Effect.map((renderer) => renderer?.html ?? null),
  );
}
