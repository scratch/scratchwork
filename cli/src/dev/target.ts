/*
 * Resolution of the CLI's path argument for `dev` and `publish`: a directory
 * becomes the served root, a file becomes its parent directory plus the
 * browser route for that file.
 */
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { isMarkedMarkdownRenderer } from "@scratchwork/shared/site/marker";
import { isSafeSitePath } from "@scratchwork/shared/site/paths";
import { CliError } from "../errors";
import type { DevTarget } from "./types";

/** Directories never uploaded by publish, never watched, and never scanned
 * when picking the browser path to open for a directory target. */
export const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".scratchwork-data"]);

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

    if (info.type === "Directory") {
      return { root: target, openPath: yield* directoryOpenPath(target) };
    }
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

/**
 * Picks the browser path to open for a directory target. "/" when the root
 * serves it (an index.md, or an index.html that is a real page rather than a
 * marked Markdown-renderer shell); otherwise the route of the first page file
 * found, so dev and publish open a page that exists instead of a 404. "/" when
 * the directory has no page files at all.
 */
function directoryOpenPath(
  root: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (yield* rootIndexServes(root)) return "/";
    return (yield* firstPageRoute(root)) ?? "/";
  });
}

/** Whether "/" resolves at the site root: an index.md, or an index.html whose
 * content is an authored page rather than a marked renderer shell (a shell
 * only answers "/" through an index.md, which the first check covers). */
function rootIndexServes(
  root: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (yield* isFile(paths.join(root, "index.md"))) return true;
    const indexHtml = paths.join(root, "index.html");
    if (!(yield* isFile(indexHtml))) return false;
    const html = yield* fs.readFileString(indexHtml).pipe(Effect.orElseSucceed(() => ""));
    return html !== "" && !isMarkedMarkdownRenderer(html);
  });
}

/**
 * Breadth-first search for the first page file (.html or .md) under root,
 * returning its extensionless browser route, or undefined when none exists.
 * Shallower files win; within a directory, entries are tried in locale order —
 * the same order publish bundles them. Marked renderer shells, unsafe site
 * paths, and skipped directories are ignored.
 */
function firstPageRoute(
  root: string,
): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const queue: string[] = [""];

    while (queue.length > 0) {
      const relativeDir = queue.shift() ?? "";
      const absoluteDir = relativeDir === "" ? root : paths.join(root, ...relativeDir.split("/"));
      const entries = yield* fs.readDirectory(absoluteDir).pipe(
        Effect.orElseSucceed(() => [] as string[]),
      );
      entries.sort((a, b) => a.localeCompare(b));

      for (const entry of entries) {
        const relativePath = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
        const absolutePath = paths.join(absoluteDir, entry);
        const info = yield* fs.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));

        if (info?.type === "Directory") {
          if (!SKIPPED_DIRECTORIES.has(entry) && isSafeSitePath(relativePath)) {
            queue.push(relativePath);
          }
          continue;
        }
        if (info?.type !== "File") continue;
        if (!isSafeSitePath(relativePath)) continue;

        const lower = entry.toLowerCase();
        if (lower.endsWith(".html")) {
          const html = yield* fs.readFileString(absolutePath).pipe(Effect.orElseSucceed(() => ""));
          if (isMarkedMarkdownRenderer(html)) continue;
          return routeForPage(relativePath, ".html");
        }
        if (lower.endsWith(".md")) return routeForPage(relativePath, ".md");
      }
    }
    return undefined;
  });
}

/** Converts a page file's site path to the extensionless route it is served
 * at: "docs/guide.html" -> "/docs/guide", "docs/index.md" -> "/docs/". Index
 * files get the trailing-slash form directly, skipping the 308 redirect the
 * slash-less form would answer with. */
function routeForPage(sitePath: string, extension: ".html" | ".md"): string {
  const stripped = sitePath.slice(0, -extension.length);
  if (stripped === "index") return "/";
  if (stripped.endsWith("/index")) return `/${stripped.slice(0, -"index".length)}`;
  return `/${stripped}`;
}

/** Whether the given absolute path exists and is a regular file. */
function isFile(
  absolutePath: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(absolutePath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    ),
  );
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
