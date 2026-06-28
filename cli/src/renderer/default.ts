import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRendererHtml,
  defaultRendererSourceHash,
} from "../../../shared/src/site/default-renderer.generated.js";

// The fallback renderer shell, used when a markdown route has no marked project
// index.html anywhere up the served tree.
//
// Production CLI builds import the generated shared module above, so Bun embeds
// the renderer HTML directly into the standalone binary. Source runs
// (`bun cli/src/index.ts ...`) compare the generated module's source hash against
// the current renderer source and rebuild automatically when it changed.

const buildScript = fileURLToPath(
  new URL("../../../renderer/build.js", import.meta.url),
);
const htmlPath = fileURLToPath(
  new URL("../../../renderer/dist/index.html", import.meta.url),
);
const rendererRoot = fileURLToPath(
  new URL("../../../renderer", import.meta.url),
);
const rendererShell = fileURLToPath(
  new URL("../../../renderer/shell.js", import.meta.url),
);
const rendererPackageJson = fileURLToPath(
  new URL("../../../renderer/package.json", import.meta.url),
);
const rendererLockfile = fileURLToPath(
  new URL("../../../renderer/bun.lock", import.meta.url),
);
const rendererSrc = fileURLToPath(
  new URL("../../../renderer/src", import.meta.url),
);

let currentShell = defaultRendererHtml;
let currentSourceHash = defaultRendererSourceHash;

export function loadShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const sourceHash = currentRendererSourceHash();
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

export function bakedShell(): Effect.Effect<
  string | null,
  never,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem
> {
  return loadShell();
}

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

function currentRendererSourceHash(): string | null {
  try {
    const files = rendererSourceFiles();
    if (files == null) return null;
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(relative(rendererRoot, file).split("\\").join("/"));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function rendererSourceFiles(): ReadonlyArray<string> | null {
  if (
    !existsSync(buildScript) ||
    !existsSync(rendererLockfile) ||
    !existsSync(rendererPackageJson) ||
    !existsSync(rendererShell) ||
    !existsSync(rendererSrc)
  ) {
    return null;
  }

  const files = [buildScript, rendererLockfile, rendererPackageJson, rendererShell];
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(abs);
    }
  };
  walk(rendererSrc);
  return files.sort((a, b) =>
    relative(rendererRoot, a).localeCompare(relative(rendererRoot, b)),
  );
}
