import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError } from "../errors";
import { loadShell } from "../renderer/default";
import { markMarkdownRenderer } from "../renderer/renderer";
import type { EjectConfig } from "../types";

// `scratchwork eject [file]` - write the default markdown renderer to a file
// (default index.html). When index.html starts with the renderer marker, it
// overrides the built-in renderer for rendered Markdown.
export function runEject({
  file: dest = "index.html",
}: EjectConfig): Effect.Effect<
  void,
  PlatformError | CliError,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const out = path.resolve(process.cwd(), dest);
    const exists = yield* fs.exists(out);

    if (exists) {
      yield* Console.error(
        `scratchwork eject: refusing to overwrite existing file: ${dest}`,
      );
      return yield* Effect.fail(new CliError({ code: 1 }));
    }

    const html = yield* loadShell();
    if (html == null) {
      yield* Console.error(
        "scratchwork eject: could not load the default renderer (renderer build failed)",
      );
      return yield* Effect.fail(new CliError({ code: 1 }));
    }

    yield* fs.makeDirectory(path.dirname(out), { recursive: true });
    yield* fs.writeFileString(out, markMarkdownRenderer(html));
    yield* Console.log(`Wrote default renderer to ${dest}`);
  });
}
