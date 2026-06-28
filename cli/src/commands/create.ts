import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import type { PlatformError } from "@effect/platform/Error";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import SCAFFOLD_INDEX_MD from "../../scaffold/index.md" with { type: "text" };
import SCAFFOLD_COUNTER_JS from "../../scaffold/components/Counter.js.txt" with { type: "text" };
import SCAFFOLD_HIGHLIGHT_JS from "../../scaffold/components/Highlight.js.txt" with { type: "text" };
import { CliError } from "../errors";
import type { PathConfig } from "../types";

const SCAFFOLD: Record<string, string> = {
  "index.md": SCAFFOLD_INDEX_MD,
  "components/Counter.js": SCAFFOLD_COUNTER_JS,
  "components/Highlight.js": SCAFFOLD_HIGHLIGHT_JS,
};

// `scratchwork create [path]` - scaffold a new project from the embedded starter
// (example index.md + components). Refuses to clobber existing files.
export function runCreate(
  config: PathConfig,
): Effect.Effect<
  void,
  PlatformError | CliError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const dest = config.path ?? ".";
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = paths.resolve(process.cwd(), dest);
    const targets = Object.entries(SCAFFOLD).map(([rel, content]) => ({
      rel,
      content,
      abs: paths.join(root, rel),
    }));

    const clashes = yield* Effect.filter(targets, (target) =>
      fs.exists(target.abs),
    );

    if (clashes.length) {
      yield* Console.error(
        [
          "scratchwork create: refusing to overwrite existing file(s):",
          ...clashes.map(({ rel }) => `  ${paths.join(dest, rel)}`),
        ].join("\n"),
      );
      return yield* Effect.fail(new CliError({ code: 1 }));
    }

    yield* Effect.forEach(
      targets,
      ({ abs, content }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dirname(abs), { recursive: true });
          yield* fs.writeFileString(abs, content);
        }),
      { discard: true },
    );

    const cd = dest === "." ? "" : `cd ${dest} && `;
    yield* Console.log(
      [
        `\n  Created a Scratchwork project in ${root}`,
        ...targets.map(({ rel }) => `    + ${rel}`),
        `\n  Next:  ${cd}scratchwork dev\n`,
      ].join("\n"),
    );
  });
}
