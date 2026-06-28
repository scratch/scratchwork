import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import type { PlatformError } from "@effect/platform/Error";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import EXAMPLE_INDEX_MD from "../../example/index.md" with { type: "text" };
import EXAMPLE_COUNTER_JS from "../../example/components/Counter.js.txt" with { type: "text" };
import EXAMPLE_HIGHLIGHT_JS from "../../example/components/Highlight.js.txt" with { type: "text" };
import { CliError } from "../errors";
import type { PathConfig } from "../types";

const EXAMPLE: Record<string, string> = {
  "index.md": EXAMPLE_INDEX_MD,
  "components/Counter.js": EXAMPLE_COUNTER_JS,
  "components/Highlight.js": EXAMPLE_HIGHLIGHT_JS,
};

// `scratchwork example [path]` - write example Markdown + components.
// Refuses to clobber existing files.
export function runExample(
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
    const targets = Object.entries(EXAMPLE).map(([rel, content]) => ({
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
          "scratchwork example: refusing to overwrite existing file(s):",
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
        `\n  Wrote Scratchwork example files to ${root}`,
        ...targets.map(({ rel }) => `    + ${rel}`),
        `\n  Next:  ${cd}scratchwork dev\n`,
      ].join("\n"),
    );
  });
}
