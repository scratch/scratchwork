/*
 * The .scratchwork.json project config file.
 *
 * A publish writes this file next to the published content so later commands
 * can omit --server/--workspace/--project. Lookups walk from a starting
 * directory toward the filesystem root and report where the file was found,
 * letting callers decide how much of an ancestor's config to trust.
 */
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { isRecord, parseJson } from "../../shared/src/util/json";
import { resolveProjectByPath, type ResolvedProjectRef } from "./api";
import { nonEmpty, normalizeServerUrl } from "./auth";
import { CliError } from "./errors";

export const PROJECT_CONFIG_FILE = ".scratchwork.json";

/** Decoded contents of a .scratchwork.json file; every field is optional. */
export interface ProjectConfigFile {
  readonly server?: string;
  readonly workspace?: string;
  readonly project?: string;
  readonly visibility?: string;
  readonly routePath?: string;
  readonly url?: string;
  readonly updatedAt?: string;
}

/** A found config file together with the directory that contains it. */
export interface ProjectConfigLookup {
  readonly directory: string;
  readonly config: ProjectConfigFile;
}

/**
 * Finds the nearest .scratchwork.json at or above a directory. Lookup is
 * best-effort: the first file found ends the search, and an unreadable or
 * malformed one reads as no config at all.
 */
export function readProjectConfig(
  startDirectory: string,
): Effect.Effect<ProjectConfigLookup | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    let current = startDirectory;
    while (true) {
      const path = paths.join(current, PROJECT_CONFIG_FILE);
      if (yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
        const text = yield* fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));
        const config = decodeProjectConfig(parseJson(text));
        return config == null ? null : { directory: current, config };
      }
      const parent = paths.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/** Writes .scratchwork.json into a directory. */
export function writeProjectConfig(
  directory: string,
  config: ProjectConfigFile,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.writeFileString(paths.join(directory, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  });
}

/** Picks the server from an explicit flag or config file and normalizes it, or fails. */
export function resolveServer(
  explicit: string | undefined,
  config: ProjectConfigFile | null,
  command: string,
): Effect.Effect<string, CliError> {
  return Effect.gen(function* () {
    const server = nonEmpty(explicit) ?? nonEmpty(config?.server);
    if (server == null) {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: server is required` }));
    }
    return yield* Effect.try({
      try: () => normalizeServerUrl(server),
      catch: () => new CliError({ code: 1, message: `scratchwork ${command}: invalid server` }),
    });
  });
}

/** Resolves the server for commands that run relative to the current directory. */
export function resolveServerFromCwd(
  explicit: string | undefined,
  command: string,
): Effect.Effect<string, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const lookup = yield* readProjectConfig(paths.resolve(process.cwd(), "."));
    return yield* resolveServer(explicit, lookup?.config ?? null, command);
  });
}

/**
 * Resolves a project reference from flags plus either a published project URL
 * or a local path with a .scratchwork.json. URL references may ask the server
 * to map the content path back to its workspace/project.
 */
export function resolveProjectRef(input: {
  readonly command: string;
  readonly pathOrUrl?: string;
  readonly server?: string;
  readonly workspace?: string;
  readonly project?: string;
}): Effect.Effect<
  ResolvedProjectRef,
  PlatformError | CliError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  return Effect.gen(function* () {
    const projectUrl = parseProjectUrl(input.pathOrUrl);
    if (projectUrl != null) {
      const server = yield* Effect.try({
        try: () => normalizeServerUrl(nonEmpty(input.server) ?? projectUrl.server),
        catch: () => new CliError({ code: 1, message: `scratchwork ${input.command}: invalid server` }),
      });
      const workspace = nonEmpty(input.workspace);
      const project = nonEmpty(input.project);
      if (workspace != null && project != null) return { server, workspace, project };
      const resolved = yield* resolveProjectByPath(server, projectUrl.pathname, input.command);
      return {
        server,
        workspace: workspace ?? resolved.workspace,
        project: project ?? resolved.project,
      };
    }

    const paths = yield* Path.Path;
    const start = paths.resolve(process.cwd(), input.pathOrUrl ?? ".");
    const statPath = yield* directoryForConfig(start);
    const lookup = yield* readProjectConfig(statPath);
    const config = lookup?.config ?? null;
    const server = yield* resolveServer(input.server, config, input.command);
    const workspace = nonEmpty(input.workspace) ?? nonEmpty(config?.workspace);
    const project = nonEmpty(input.project) ?? nonEmpty(config?.project);
    if (workspace == null || project == null) {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${input.command}: workspace and project are required`,
      }));
    }
    return { server, workspace, project };
  });
}

/** Maps a path argument to the directory whose config should be consulted. */
function directoryForConfig(path: string): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return paths.dirname(path);
    const info = yield* fs.stat(path);
    return info.type === "Directory" ? path : paths.dirname(path);
  });
}

/** Splits a project URL into its server origin and content path, or null for non-URLs. */
function parseProjectUrl(value: string | undefined): { readonly server: string; readonly pathname: string } | null {
  if (value == null || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return null;
  try {
    const url = new URL(value);
    return { server: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
}

/** Validates and narrows parsed JSON into a ProjectConfigFile, dropping unknown fields. */
function decodeProjectConfig(value: unknown): ProjectConfigFile | null {
  if (!isRecord(value)) return null;
  const config: Record<string, string> = {};
  if (typeof value.server === "string") config.server = value.server;
  if (typeof value.workspace === "string") config.workspace = value.workspace;
  if (typeof value.project === "string") config.project = value.project;
  if (typeof value.visibility === "string") config.visibility = value.visibility;
  if (typeof value.routePath === "string") config.routePath = value.routePath;
  if (typeof value.url === "string") config.url = value.url;
  if (typeof value.updatedAt === "string") config.updatedAt = value.updatedAt;
  return config;
}
