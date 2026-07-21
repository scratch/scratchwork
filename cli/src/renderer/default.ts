/*
 * The fallback renderer shell, used when a markdown route has no marked project
 * index.html anywhere up the served tree.
 *
 * Production CLI builds import the generated shared module below, so Bun embeds
 * the renderer HTML directly into the standalone binary. Source runs
 * (`bun cli/src/index.ts ...`) compare the generated module's source hash against
 * the current renderer source and rebuild automatically when it changed.
 */
import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRendererHtml,
  defaultRendererSourceHash,
} from "@scratchwork/shared/site/default-renderer.generated.js";

const rendererRootUrl = new URL("../../../renderer/", import.meta.url);
const rendererRoot = fileURLToPath(rendererRootUrl);

/** Resolves a path inside the renderer package's source tree. */
const rendererPath = (path: string) => fileURLToPath(new URL(path, rendererRootUrl));

const buildScript = rendererPath("build.js");
const htmlPath = rendererPath("dist/index.html");
const rendererSrc = rendererPath("src");
const rendererRootFiles = ["build.js", "bun.lock", "package.json", "shell.js"].map(
  rendererPath,
);

let currentShell = defaultRendererHtml;
let currentSourceHash = defaultRendererSourceHash;

/**
 * Returns the default renderer shell HTML, rebuilding it first when the
 * renderer source on disk has changed since the shell was generated. Returns
 * null when no shell is available (build failed and none was embedded).
 */
export function loadShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const sourceHash = yield* currentRendererSourceHash();
    if (sourceHash == null || sourceHash === currentSourceHash) {
      return currentShell;
    }

    const html = yield* buildShell("renderer source changed");
    if (html == null) return null;
    currentShell = html;
    currentSourceHash = sourceHash;
    return currentShell;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/** Runs the renderer package's build and reads the produced shell HTML. */
function buildShell(reason: string): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* Console.log(`  building renderer shell (${reason})…`);
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

/** Hashes the renderer's source files, or returns null when they are not on disk. */
function currentRendererSourceHash(): Effect.Effect<string | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* rendererSourceFiles();
    if (files == null) return null;
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(relative(rendererRoot, file).split("\\").join("/"));
      hash.update("\0");
      hash.update(yield* fs.readFile(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/** Lists the files that participate in the source hash, or null when incomplete. */
function rendererSourceFiles(): Effect.Effect<ReadonlyArray<string> | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const required = [...rendererRootFiles, rendererSrc];
    const exists = yield* Effect.forEach(required, (path) => fs.exists(path));
    if (exists.some((present) => !present)) return null;

    const files = [...rendererRootFiles];
    files.push(...(yield* collectFiles(rendererSrc)));
    return files.sort((a, b) =>
      relative(rendererRoot, a).localeCompare(relative(rendererRoot, b)),
    );
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/** Recursively lists regular files under a directory, tolerating read failures. */
function collectFiles(dir: string): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(dir).pipe(
      Effect.catchAll(() => Effect.succeed([] as Array<string>)),
    );
    entries.sort((a, b) => a.localeCompare(b));

    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const abs = join(dir, entry);
        const info = yield* fs.stat(abs).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (info == null) return [] as Array<string>;
        if (info.type === "Directory") return [...(yield* collectFiles(abs))];
        return info.type === "File" ? [abs] : [];
      }),
    );
    return nested.flat();
  });
}
