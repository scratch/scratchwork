/*
 * Commands that operate on published projects: `me`, `projects`, `info`,
 * `share`, `revoke`, `unpublish`, `delete`, `clone`, and `stream`. All server traffic goes
 * through the shared api module; project references come from flags, a
 * published URL, or a local .scratchwork.json (see project-config.ts).
 */
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { base64ToBytes } from "../../../shared/src/encoding/base64";
import { decodePublishBundle } from "../../../shared/src/publish/bundle";
import { isSafeProjectIdentifier } from "../../../shared/src/site/identifiers";
import { isRecord } from "../../../shared/src/util/json";
import { apiErrorText, apiJson, apiRequest, projectApiUrl } from "../api";
import { readAuthToken, serverApiUrl } from "../auth";
import { CliError, errorMessage } from "../errors";
import { PROJECT_CONFIG_FILE, resolveProjectRef, resolveServerFromCwd, writeProjectConfig } from "../project-config";
import type { CloneConfig, PathConfig, ProjectRefConfig, ServerConfig, ShareConfig } from "../types";
import { runPublish, SKIPPED_DIRECTORIES, type PublishServices } from "./publish";

/** Project metadata as returned by /api/projects. */
interface ApiProject {
  readonly project: string;
  readonly visibility: string;
  readonly url?: string;
  readonly updatedAt: string;
}

/** Services shared by the project management commands. */
type ProjectServices = FileSystem.FileSystem | HttpClient.HttpClient | Path.Path;

/** Runs `scratchwork me`: prints the server's view of the authenticated user. */
export function runMe(
  config: ServerConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const server = yield* resolveServerFromCwd(config.server, "me");
    const token = yield* readAuthToken(server);
    const body = yield* apiJson("scratchwork me", serverApiUrl(server, "/api/me"), { token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

/** Runs `scratchwork projects`: lists the authenticated user's projects. */
export function runProjects(
  config: ServerConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const server = yield* resolveServerFromCwd(config.server, "projects");
    const token = yield* readAuthToken(server);
    const body = yield* apiJson("scratchwork projects", serverApiUrl(server, "/api/projects"), { token });
    const projects = isRecord(body) && Array.isArray(body.projects) ? body.projects as ReadonlyArray<ApiProject> : [];
    if (projects.length === 0) {
      yield* Console.log("No projects.");
      return;
    }
    yield* Console.log(projects.map((project) =>
      `${project.project}\t${project.visibility}\t${project.url ?? `/${project.project}/`}`,
    ).join("\n"));
  });
}

/** Runs `scratchwork info`: prints one project's metadata as JSON. */
export function runInfo(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "info" });
    const token = yield* readAuthToken(ref.server);
    const body = yield* apiJson("scratchwork info", projectApiUrl(ref), { token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

/** Runs `scratchwork unpublish`: sets a project's visibility to private. */
export function runUnpublish(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "unpublish" });
    const token = yield* readAuthToken(ref.server);
    const body = yield* apiJson("scratchwork unpublish", projectApiUrl(ref, "/unpublish"), { method: "POST", token });
    yield* Console.log(JSON.stringify(body, null, 2));
  });
}

/** Runs `scratchwork share`: assigns accounts or whole domains a role on a project
 * (read, write, or admin; sharing again with a different role moves the target). */
export function runShare(
  config: ShareConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return runShareChange("share", { add: true, role: config.role ?? "read" }, config);
}

/** Runs `scratchwork revoke`: strips every role the targets hold on a project. */
export function runRevoke(
  config: ShareConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return runShareChange("revoke", { add: false }, config);
}

/** Shared body of share/revoke: sort positionals into targets vs the project
 * reference, then POST the grant delta. Targets always contain an "@" (emails and
 * @domain groups); a published URL or local path never does, so the two can mix
 * freely on the command line. */
function runShareChange(
  command: "share" | "revoke",
  change: { readonly add: boolean; readonly role?: "read" | "write" | "admin" },
  config: ShareConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const targets = config.targets.filter((value) => value.includes("@"));
    const refs = config.targets.filter((value) => !value.includes("@"));
    if (targets.length === 0) {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${command}: pass at least one email address or @domain group (for example alice@example.com or @example.com)`,
      }));
    }
    if (refs.length > 1) {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${command}: expected at most one project path or URL, got: ${refs.join(", ")}`,
      }));
    }
    const ref = yield* resolveProjectRef({ command, pathOrUrl: refs[0], server: config.server, project: config.project });
    const token = yield* readAuthToken(ref.server);
    const response = yield* apiRequest(`scratchwork ${command}`, projectApiUrl(ref, "/share"), {
      method: "POST",
      token,
      body: change.add ? { add: targets, role: change.role } : { remove: targets },
    });
    // A missing project reads "Project not found"; a bare route-level "Not found" means
    // the server predates the /share API and would otherwise be indistinguishable noise.
    if (response.status === 404 && apiErrorText(response) === "Not found") {
      return yield* Effect.fail(new CliError({
        code: 1,
        message: `scratchwork ${command}: ${ref.server} does not support sharing yet (no /share API). Update the server to a newer Scratchwork release and try again.`,
      }));
    }
    if (!response.ok) {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork ${command}: ${apiErrorText(response)}` }));
    }
    yield* Console.log(JSON.stringify(response.json, null, 2));
  });
}

/** Runs `scratchwork delete`: removes a project from the server, releasing its name. */
export function runDelete(
  config: ProjectRefConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ ...config, command: "delete" });
    const token = yield* readAuthToken(ref.server);
    yield* apiJson("scratchwork delete", projectApiUrl(ref), { method: "DELETE", token });
    yield* Console.log(`Deleted ${ref.project}`);
  });
}

/** Runs `scratchwork clone`: downloads a project's bundle into ./<project>. */
export function runClone(
  config: CloneConfig,
): Effect.Effect<void, PlatformError | CliError, ProjectServices> {
  return Effect.gen(function* () {
    const ref = yield* resolveProjectRef({ command: "clone", pathOrUrl: config.pathOrUrl });
    // The project name may come from the server or a local config file; refuse
    // anything that could escape the destination directory.
    if (!isSafeProjectIdentifier(ref.project)) {
      return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork clone: unsafe project name ${ref.project}` }));
    }
    const token = yield* readAuthToken(ref.server);
    const body = yield* apiJson("scratchwork clone", projectApiUrl(ref, "/bundle"), { token });
    const bundle = isRecord(body) ? decodePublishBundle(body.bundle) : null;
    if (bundle == null) {
      return yield* Effect.fail(new CliError({ code: 1, message: "scratchwork clone: invalid server response" }));
    }

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const destination = paths.resolve(process.cwd(), ref.project);
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const file of bundle.files) {
      const bytes = base64ToBytes(file.contentBase64);
      if (bytes == null) {
        return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork clone: invalid file content ${file.path}` }));
      }
      const outputPath = paths.join(destination, ...file.path.split("/"));
      yield* fs.makeDirectory(paths.dirname(outputPath), { recursive: true });
      yield* fs.writeFile(outputPath, bytes);
    }
    // Publish bundles exclude the root config, so without this a clone carries no
    // identity and a republish would ride on the (renamable) directory name — on a
    // random-naming server, a renamed clone would silently fork a new project.
    yield* writeProjectConfig(destination, { server: ref.server, project: ref.project });
    yield* Console.log(`Cloned ${ref.project} to ${destination}`);
  });
}

/**
 * Runs `scratchwork stream`: publishes once (opening the browser), then
 * watches the directory and republishes after each debounced burst of file
 * changes. Republishes run sequentially and a failed publish logs an error
 * without stopping the stream.
 */
export function runStream(
  config: PathConfig,
): Effect.Effect<void, PlatformError | CliError, PublishServices> {
  return Effect.gen(function* () {
    yield* resolveProjectRef({ command: "stream", pathOrUrl: config.path });
    yield* runPublish({ path: config.path });
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const directory = paths.resolve(process.cwd(), config.path);
    yield* Console.log("Streaming changes. Press Ctrl-C to stop.");
    yield* fs.watch(directory, { recursive: true }).pipe(
      Stream.filter((event) => shouldRepublish(paths, event.path)),
      Stream.debounce("250 millis"),
      Stream.runForEach(() =>
        runPublish({ path: config.path }, { openBrowser: false }).pipe(
          Effect.catchAll((error) => Console.error(`scratchwork stream: ${errorMessage(error)}`)),
        ),
      ),
    );
  });
}

/** Filters out watch events publish would not upload anyway (config writes, deps, VCS). */
function shouldRepublish(paths: Path.Path, pathname: string): boolean {
  if (!pathname) return false;
  if (pathname.split(/[\\/]/).some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false;
  return paths.basename(pathname) !== PROJECT_CONFIG_FILE;
}

