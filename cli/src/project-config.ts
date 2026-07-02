import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { isRecord, parseJson } from "../../shared/src/util/json";
import { normalizeServerUrl, readAuthRecord } from "./auth";
import { CliError } from "./errors";

export const PROJECT_CONFIG_FILE = ".scratchwork.json";

export interface ProjectConfigFile {
  readonly server?: string;
  readonly workspace?: string;
  readonly project?: string;
  readonly visibility?: string;
  readonly routePath?: string;
  readonly url?: string;
  readonly updatedAt?: string;
}

export interface ResolvedProjectRef {
  readonly server: string;
  readonly workspace: string;
  readonly project: string;
}

export function readProjectConfig(
  startDirectory: string,
): Effect.Effect<ProjectConfigFile | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    let current = startDirectory;
    while (true) {
      const path = paths.join(current, PROJECT_CONFIG_FILE);
      if (yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
        const text = yield* fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));
        return decodeProjectConfig(parseJson(text));
      }
      const parent = paths.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

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

export function resolveServer(
  explicit: string | undefined,
  config: ProjectConfigFile | null,
  command: string,
): Effect.Effect<string, CliError> {
  return Effect.try({
    try: () => {
      const server = nonEmpty(explicit) ?? nonEmpty(config?.server);
      if (server == null) {
        throw new CliError({ code: 1, message: `scratchwork ${command}: server is required` });
      }
      return normalizeServerUrl(server);
    },
    catch: (cause) => cause instanceof CliError
      ? cause
      : new CliError({ code: 1, message: `scratchwork ${command}: invalid server` }),
  });
}

export function resolveProjectRef(input: {
  readonly command: string;
  readonly pathOrUrl?: string;
  readonly server?: string;
  readonly workspace?: string;
  readonly project?: string;
}): Effect.Effect<ResolvedProjectRef, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
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
    const projectConfig = yield* readProjectConfig(statPath);
    const server = yield* resolveServer(input.server, projectConfig, input.command);
    const workspace = nonEmpty(input.workspace) ?? nonEmpty(projectConfig?.workspace);
    const project = nonEmpty(input.project) ?? nonEmpty(projectConfig?.project);
    if (workspace == null || project == null) {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${input.command}: workspace and project are required`,
      }));
    }
    return { server, workspace, project };
  });
}

export function projectApiUrl(ref: ResolvedProjectRef, suffix = ""): string {
  const url = new URL(`/api/projects/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}${suffix}`, ref.server);
  return url.toString();
}

export function authHeaders(token: string | undefined): Record<string, string> {
  return token == null ? {} : { authorization: `Bearer ${token}` };
}

export function authTokenForServer(
  server: string,
): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem | Path.Path> {
  return readAuthRecord(server).pipe(Effect.map((record) => record?.token));
}

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

function parseProjectUrl(value: string | undefined): { readonly server: string; readonly pathname: string } | null {
  if (value == null || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return null;
  try {
    const url = new URL(value);
    return { server: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
}

/** Asks the server which project a published content path belongs to. Route paths depend
 * on server config (random slugs, username/project, ...), so only the server can map a
 * URL back to its workspace/project. */
function resolveProjectByPath(
  server: string,
  pathname: string,
  command: string,
): Effect.Effect<{ readonly workspace: string; readonly project: string }, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const token = yield* authTokenForServer(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const resolveUrl = new URL("/api/resolve", server);
    resolveUrl.searchParams.set("path", pathname === "" ? "/" : pathname);
    const body = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(resolveUrl.toString(), { headers: authHeaders(token) });
        const text = await response.text();
        const json = parseJson(text);
        if (!response.ok) {
          const message = isRecord(json) && typeof json.error === "string" ? json.error : `server returned ${response.status}`;
          throw new CliError({ code: 1, message: `scratchwork ${command}: ${message}` });
        }
        return json;
      },
      catch: (cause) => cause instanceof CliError
        ? cause
        : new CliError({ code: 1, message: `scratchwork ${command}: could not resolve project URL` }),
    });
    const project = isRecord(body) && isRecord(body.project) ? body.project : null;
    if (project == null || typeof project.workspace !== "string" || typeof project.project !== "string") {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: invalid server response` }));
    }
    return { workspace: project.workspace, project: project.project };
  });
}

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

function nonEmpty(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
