import * as Effect from "effect/Effect";
import { SiteFileError, SiteFiles } from "./files";
import { isMarkedMarkdownRenderer } from "./marker";
import { dirnameSitePath, joinSitePath, type SitePath } from "./paths";

export function nearestMarkdownRenderer<E, R>(
  startDir: SitePath,
  fallback: Effect.Effect<string | null, E, R>,
): Effect.Effect<string | null, E | SiteFileError, SiteFiles | R> {
  return Effect.gen(function* () {
    const files = yield* SiteFiles;
    let current = startDir;

    while (true) {
      const candidate = joinSitePath(current, "index.html");
      if (yield* files.exists(candidate)) {
        const html = yield* files.readText(candidate);
        if (isMarkedMarkdownRenderer(html)) return html;
      }
      if (current === "") break;
      const parent = dirnameSitePath(current);
      if (parent === current) break;
      current = parent;
    }

    return yield* fallback;
  });
}
