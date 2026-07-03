/*
 * `scratchwork template` - write the default Markdown renderer shell to a
 * local HTML file so a project can customize its own renderer.
 */
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { markMarkdownRenderer } from "../../../shared/src/site/marker";
import { CliError } from "../errors";
import { loadShell } from "../renderer/default";
import type { TemplateConfig } from "../types";

/**
 * Runs `scratchwork template`: writes the default markdown renderer shell to
 * a file (default index.html), refusing to clobber existing files.
 */
export function runTemplate({
  file: dest,
}: TemplateConfig): Effect.Effect<
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
        `scratchwork template: refusing to overwrite existing file: ${dest}`,
      );
      return yield* Effect.fail(new CliError({ code: 1 }));
    }

    const html = yield* loadShell();
    if (html == null) {
      yield* Console.error(
        "scratchwork template: could not load the default renderer (renderer build failed)",
      );
      return yield* Effect.fail(new CliError({ code: 1 }));
    }

    yield* fs.makeDirectory(path.dirname(out), { recursive: true });
    yield* fs.writeFileString(out, markMarkdownRenderer(html));
    yield* Console.log(`Wrote default renderer to ${dest}`);
  });
}
