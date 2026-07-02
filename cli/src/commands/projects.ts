import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { watch } from "node:fs";
import { base64ToBytes } from "../../../shared/src/encoding/base64";
import { isSafeSitePath } from "../../../shared/src/site/paths";
import { isRecord, parseJson } from "../../../shared/src/util/json";
import { PROJECT_CONFIG_FILE, authHeaders, authTokenForServer, projectApiUrl, readProjectConfig, resolveProjectRef, resolveServer } from "../project-config";
import { CliError, errorMessage } from "../errors";
import type { CloneConfig, ProjectRefConfig, ServerConfig } from "../types";
import { runPublish } from "./publish";

interface ApiProject {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: string;
  readonly url?: string;
  readonly updatedAt: string;
}

interface BundleResponse {
  readonly bundle: {
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly contentBase64: string;
    }>;
  };
}

export function runMe(
  config: ServerConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const server = yield* serverFromCurrentDirectory(config.server, "me");
    const token = yield* authTokenForServer(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const body = yield* requestJson(new URL("/api/me", server).toString(), { token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

export function runProjects(
  config: ServerConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const server = yield* serverFromCurrentDirectory(config.server, "projects");
    const token = yield* authTokenForServer(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const body = yield* requestJson(new URL("/api/projects", server).toString(), { token });
    const projects = isRecord(body) && Array.isArray(body.projects) ? body.projects as ReadonlyArray<ApiProject> : [];
    if (projects.length === 0) {
      yield* Console.log("No projects.");
      return;
    }
    yield* Console.log(projects.map((project) =>
      `${project.workspace}/${project.project}\t${project.visibility}\t${project.url ?? project.routePath}`,
    ).join("\n"));
  });
}

export function runInfo(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "info" });
    const token = yield* authTokenForServer(ref.server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const body = yield* requestJson(projectApiUrl(ref), { token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

export function runUnpublish(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "unpublish" });
    const token = yield* authTokenForServer(ref.server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const body = yield* requestJson(projectApiUrl(ref, "/unpublish"), { method: "POST", token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

export function runDelete(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "delete" });
    const token = yield* authTokenForServer(ref.server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    yield* requestJson(projectApiUrl(ref), { method: "DELETE", token });
    yield* Console.log(`Deleted ${ref.workspace}/${ref.project}`);
  });
}

export function runClone(
  config: CloneConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ command: "clone", pathOrUrl: config.pathOrUrl });
    const token = yield* authTokenForServer(ref.server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const body = yield* requestJson(projectApiUrl(ref, "/bundle"), { token });
    const decoded = decodeBundleResponse(body);
    if (decoded == null) {
      return yield* Effect.fail(new CliError({ code: 1, message: "scratchwork clone: invalid server response" }));
    }

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const destination = paths.resolve(process.cwd(), ref.project);
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const file of decoded.bundle.files) {
      const bytes = base64ToBytes(file.contentBase64);
      if (bytes == null) {
        return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork clone: invalid file content ${file.path}` }));
      }
      const outputPath = paths.join(destination, ...file.path.split("/"));
      yield* fs.makeDirectory(paths.dirname(outputPath), { recursive: true });
      yield* fs.writeFile(outputPath, bytes);
    }
    yield* Console.log(`Cloned ${ref.workspace}/${ref.project} to ${destination}`);
  });
}

export function runStream(
  config: { readonly path?: string },
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* resolveProjectRef({ command: "stream", pathOrUrl: config.path ?? "." });
    yield* runPublish({ path: config.path });
    const paths = yield* Path.Path;
    const directory = paths.resolve(process.cwd(), config.path ?? ".");
    yield* Console.log("Streaming changes. Press Ctrl-C to stop.");
    return yield* Effect.async<void, never>((resume) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(directory, { recursive: true }, (_event, filename) => {
        if (filename === PROJECT_CONFIG_FILE || filename?.includes("node_modules")) return;
        if (timer != null) clearTimeout(timer);
        timer = setTimeout(() => {
          const args = [process.argv[1] ?? "scratchwork", "publish", config.path ?? "."];
          Bun.spawn(args, {
            env: { ...process.env, SCRATCHWORK_NO_OPEN: "1" },
            stdout: "inherit",
            stderr: "inherit",
          });
        }, 250);
      });
      return Effect.sync(() => {
        if (timer != null) clearTimeout(timer);
        watcher.close();
        resume(Effect.void);
      });
    });
  });
}

function serverFromCurrentDirectory(
  explicit: string | undefined,
  command: string,
): Effect.Effect<string, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const config = yield* readProjectConfig(paths.resolve(process.cwd(), "."));
    return yield* resolveServer(explicit, config, command);
  });
}

function requestJson(
  url: string,
  options: {
    readonly method?: string;
    readonly token?: string;
  } = {},
): Effect.Effect<unknown, CliError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: authHeaders(options.token),
      });
      const text = await response.text();
      const body = parseJson(text);
      if (!response.ok) {
        const message = isRecord(body) && typeof body.error === "string" ? body.error : text;
        throw new CliError({ code: 1, message: `scratchwork: ${message || `server returned ${response.status}`}` });
      }
      return body;
    },
    catch: (cause) => cause instanceof CliError
      ? cause
      : new CliError({ code: 1, message: `scratchwork: ${errorMessage(cause)}` }),
  });
}

function decodeBundleResponse(value: unknown): BundleResponse | null {
  if (!isRecord(value) || !isRecord(value.bundle) || !Array.isArray(value.bundle.files)) return null;
  for (const file of value.bundle.files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.contentBase64 !== "string") return null;
    if (!isSafeSitePath(file.path)) return null;
  }
  return value as unknown as BundleResponse;
}

