import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
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
    const urlRef = parseProjectUrl(input.pathOrUrl);
    if (urlRef != null) {
      const server = yield* Effect.try({
        try: () => normalizeServerUrl(nonEmpty(input.server) ?? urlRef.server),
        catch: () => new CliError({ code: 1, message: `scratchwork ${input.command}: invalid server` }),
      });
      return {
        server,
        workspace: nonEmpty(input.workspace) ?? urlRef.workspace,
        project: nonEmpty(input.project) ?? urlRef.project,
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

export function personalWorkspaceForEmail(email: string | undefined): string | undefined {
  if (email == null) return undefined;
  return slugifyIdentifier(email.split("@", 1)[0] ?? "", "user");
}

export function slugifyIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 128);
  return safeIdentifier(normalized) ? normalized : fallback;
}

export function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
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

function parseProjectUrl(value: string | undefined): ResolvedProjectRef | null {
  if (value == null || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return null;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
    if (segments.length < 2) return null;
    return {
      server: url.origin,
      workspace: segments[0],
      project: segments[1],
    };
  } catch {
    return null;
  }
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
