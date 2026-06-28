import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

// The renderer shell, used when a markdown route has no marked project
// index.html anywhere up the served tree. Resolved lazily and memoized:
//   - In the standalone binary (cli/build.js), the literal import below is
//     embedded by `bun build --compile`, so it just resolves.
//   - Run directly from source (`bun cli/src/index.ts`), it loads
//     ../../../template/dist/shell.js, building the renderer first if dist is absent.

const buildScript = fileURLToPath(
  new URL("../../../template/build.js", import.meta.url),
);
const htmlPath = fileURLToPath(
  new URL("../../../template/dist/index.html", import.meta.url),
);

export function loadShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return importShell().pipe(
    Effect.flatMap((html) =>
      html == null ? buildShell() : Effect.succeed(html),
    ),
  );
}

const cachedShell = Effect.runSync(Effect.cached(loadShell()));

export function bakedShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return cachedShell;
}

function importShell(): Effect.Effect<string | null> {
  return Effect.tryPromise({
    try: async () =>
      ((await import("../../../template/dist/shell.js")) as { default: string })
        .default,
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function buildShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* Console.log("  building renderer shell (template/dist not found)…");
    const exitCode = yield* Command.make("bun", buildScript).pipe(
      Command.stdout("inherit"),
      Command.stderr("inherit"),
      Command.exitCode,
    );
    if (exitCode !== 0) return null;

    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(htmlPath).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}
