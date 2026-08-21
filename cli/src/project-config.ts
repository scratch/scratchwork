/*
 * The .scratchwork.json project config file.
 *
 * A publish writes this file next to the published content so later commands
 * can omit --server/--project. Lookups walk from a starting directory toward
 * the filesystem root and report where the file was found, letting callers
 * decide how much of an ancestor's config to trust.
 */
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Either from "effect/Either";
import * as Predicate from "effect/Predicate";
import { isSafeProjectIdentifier } from "@scratchwork/shared/site/identifiers";
import { resolveProjectByPath, type ResolvedProjectRef } from "./api";
import { normalizeServerUrl } from "./auth";
import { CliError } from "./errors";

export const PROJECT_CONFIG_FILE = ".scratchwork.json";

/** The .scratchwork.json file contents. Every field is optional — the file is
 * user-editable and partial configs are valid. This is a local persistence format,
 * deliberately separate from the wire types in shared/src/publish/api.ts, so API
 * changes never silently change what is written to users' disks. */
const ProjectConfigFileSchema = Schema.Struct({
  server: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  isPublic: Schema.optional(Schema.Boolean),
  commentsEnabled: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});

/** Decoded contents of a .scratchwork.json file; every field is optional. */
export type ProjectConfigFile = typeof ProjectConfigFileSchema.Type;

/** A found config file together with the directory that contains it. */
export interface ProjectConfigLookup {
  readonly directory: string;
  readonly config: ProjectConfigFile;
}

/**
 * Finds the nearest .scratchwork.json at or above a directory. Lookup is
 * best-effort: the first file found ends the search, and an unreadable or
 * malformed one reads as no config at all — except a config still carrying
 * workspace-era fields, which fails loudly so stale identity is never
 * silently reinterpreted.
 */
export function readProjectConfig(
  startDirectory: string,
): Effect.Effect<ProjectConfigLookup | null, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    let current = startDirectory;
    while (true) {
      const path = paths.join(current, PROJECT_CONFIG_FILE);
      if (yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
        const text = yield* fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));
        const parsed = Either.getOrNull(Schema.decodeUnknownEither(Schema.parseJson())(text));
        yield* rejectLegacyConfig(parsed, path);
        const config = decodeProjectConfig(parsed);
        return config == null ? null : { directory: current, config };
      }
      const parent = paths.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }).pipe(Effect.catchAll((error) => error instanceof CliError ? Effect.fail(error) : Effect.succeed(null)));
}

/** Fails with an explicit error when a config still carries workspace-era fields. */
function rejectLegacyConfig(value: unknown, path: string): Effect.Effect<void, CliError> {
  if (!Predicate.isRecord(value)) return Effect.void;
  const legacy = ["workspace", "routePath"].filter((key) => key in value);
  if (legacy.length === 0) return Effect.void;
  return Effect.fail(new CliError({
    code: 1,
    message: `scratchwork: ${path} contains legacy field${legacy.length > 1 ? "s" : ""} ${legacy.map((key) => `"${key}"`).join(" and ")} from the workspace era. ` +
      `Delete the file or remove ${legacy.length > 1 ? "those fields" : "that field"}, then republish (pass --project to keep a specific name).`,
  }));
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
    const server = explicit || config?.server || undefined;
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
 * to map the content path back to its project.
 */
export function resolveProjectRef(input: {
  readonly command: string;
  readonly pathOrUrl?: string;
  readonly server?: string;
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
        try: () => normalizeServerUrl(input.server || projectUrl.server),
        catch: () => new CliError({ code: 1, message: `scratchwork ${input.command}: invalid server` }),
      });
      const project = input.project;
      if (project) return yield* safeProjectRef(input.command, { server, project });
      const resolved = yield* resolveProjectByPath(server, projectUrl.pathname, input.command);
      return yield* safeProjectRef(input.command, { server, project: resolved.project });
    }

    const paths = yield* Path.Path;
    const start = paths.resolve(process.cwd(), input.pathOrUrl ?? ".");
    const statPath = yield* directoryForConfig(start);
    const lookup = yield* readProjectConfig(statPath);
    const config = lookup?.config ?? null;
    const server = yield* resolveServer(input.server, config, input.command);
    const project = input.project || config?.project || undefined;
    if (project == null) {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${input.command}: project is required`,
      }));
    }
    return yield* safeProjectRef(input.command, { server, project });
  });
}

/** Rejects a project name (from flags, a config file, or the server) that the
 * contract's project-identifier grammar would refuse, so commands fail with a
 * clear message instead of a request-encoding error. */
function safeProjectRef(command: string, ref: ResolvedProjectRef): Effect.Effect<ResolvedProjectRef, CliError> {
  return isSafeProjectIdentifier(ref.project)
    ? Effect.succeed(ref)
    : Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: unsafe project name ${ref.project}` }));
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

/** Validates and narrows parsed JSON into a ProjectConfigFile, dropping unknown
 * fields; a wrong-typed field makes the whole file read as no config, per the
 * best-effort lookup contract. Workspace-era fields never reach here —
 * rejectLegacyConfig fails on them first. Omitting isPublic is safe because the
 * server then preserves the project's current setting (and defaults new projects
 * to private). */
function decodeProjectConfig(value: unknown): ProjectConfigFile | null {
  return Option.getOrNull(Schema.decodeUnknownOption(ProjectConfigFileSchema)(value));
}
