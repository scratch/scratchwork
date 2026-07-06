/*
 * Resolution of the CLI's path argument for `dev` and `publish`: a directory
 * becomes the served root, a file becomes its parent directory plus the
 * browser route for that file.
 */
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { CliError } from "../errors";
import type { DevTarget } from "./types";

/** Converts the CLI path argument into the server root and browser path to open. */
export function resolveDevTarget(
  pathArg: string,
  command = "dev",
): Effect.Effect<
  DevTarget,
  PlatformError | CliError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const target = paths.resolve(process.cwd(), pathArg);
    if (!(yield* fs.exists(target))) {
      return yield* noSuchFile(command, target);
    }
    const info = yield* fs.stat(target);

    if (info.type === "Directory") return { root: target, openPath: "/" };
    if (info.type === "File") {
      return {
        root: paths.dirname(target),
        openPath: openPathForFile(paths.basename(target)),
        file: paths.basename(target),
      };
    }
    return yield* noSuchFile(command, target);
  });
}

/** Builds the extensionless browser path for a file passed as the target. */
function openPathForFile(filename: string): string {
  const lower = filename.toLowerCase();
  const route = lower.endsWith(".html")
    ? filename.slice(0, -".html".length)
    : lower.endsWith(".md")
      ? filename.slice(0, -".md".length)
      : filename;
  return route.toLowerCase() === "index" ? "/" : `/${route}`;
}

/** Creates the user-facing CLI error for invalid dev targets. */
function noSuchFile(command: string, path: string): Effect.Effect<never, CliError> {
  return Effect.fail(
    new CliError({
      code: 1,
      message: `scratchwork ${command}: no such file or directory: ${path}`,
    }),
  );
}
