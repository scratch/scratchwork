/*
 * `scratchwork publish` - upload a project directory (or single file) to a
 * Scratchwork server as a base64 file bundle, then record the published
 * coordinates in .scratchwork.json for later commands.
 */
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { bytesToBase64, PUBLISH_BUNDLE_VERSION, type PublishBundle } from "../../../shared/src/publish/bundle";
import { safeProjectIdentifier, slugifyIdentifier } from "../../../shared/src/site/identifiers";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { isRecord } from "../../../shared/src/util/json";
import { apiErrorText, apiRequest } from "../api";
import { nonEmpty, readAuthToken, serverApiUrl } from "../auth";
import { openBrowser } from "../browser";
import { resolveDevTarget } from "../dev/target";
import { CliError, errorMessage } from "../errors";
import {
  PROJECT_CONFIG_FILE,
  readProjectConfig,
  resolveServer,
  writeProjectConfig,
  type ProjectConfigFile,
} from "../project-config";
import type { PublishConfig } from "../types";
import { runLogin } from "./login";

/** Directories never uploaded by publish and never watched by stream. */
export const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".scratchwork-data"]);

/** Services runPublish needs; exported for callers that wrap it (stream). */
export type PublishServices = CommandExecutor | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path;

/** The server's response to a successful publish. */
interface PublishResponse {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: string;
  readonly openPath: string;
  readonly url: string;
}

/** 401 from the publish endpoint: distinguished so runPublish can log in and retry. */
class PublishAuthRequired extends CliError {}

/**
 * Runs `scratchwork publish`. A .scratchwork.json in the published directory
 * itself supplies defaults for every field; one found in an ancestor directory
 * supplies only the server, so publishing a subdirectory creates its own
 * project instead of silently overwriting the ancestor's.
 */
export function runPublish(
  config: PublishConfig,
  options: { readonly openBrowser?: boolean } = {},
): Effect.Effect<void, PlatformError | CliError, PublishServices> {
  return Effect.gen(function* () {
    const target = yield* resolveDevTarget(config.path, "publish");
    const lookup = yield* readProjectConfig(target.root);
    const projectConfig = lookup?.directory === target.root ? lookup.config : null;
    const server = yield* resolveServer(config.server, lookup?.config ?? null, "publish");
    const authToken = yield* readAuthToken(server);
    const project = yield* resolveProjectName(config, projectConfig);
    // Omitted workspace/visibility let the server preserve an existing project's
    // visibility and apply its defaultWorkspace/defaultVisibility policy.
    const workspace = nonEmpty(config.workspace) ?? nonEmpty(projectConfig?.workspace);
    const visibility = nonEmpty(config.visibility) ?? nonEmpty(projectConfig?.visibility);

    const bundle = yield* createBundle(target.root);
    const body = {
      bundle,
      openPath: target.openPath,
      workspace,
      project,
      visibility,
    };
    const response = yield* postPublish(server, body, authToken).pipe(
      Effect.catchIf((error) => error instanceof PublishAuthRequired, () =>
        Effect.gen(function* () {
          yield* runLogin({ server });
          const refreshed = yield* readAuthToken(server);
          return yield* postPublish(server, body, refreshed);
        }),
      ),
    );

    const saved = yield* writeMetadata(target.root, server, response);
    yield* printResult(response, bundle, saved);
    if (options.openBrowser !== false) yield* openBrowser(response.url);
  });
}

/** Reads every publishable file under root into a base64 bundle. */
function createBundle(
  root: string,
): Effect.Effect<PublishBundle, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const sitePaths = yield* collectFiles(root, "");
    if (sitePaths.length === 0) {
      return yield* Effect.fail(
        new CliError({ code: 1, message: "scratchwork publish: no files to publish" }),
      );
    }

    const files = yield* Effect.forEach(sitePaths, (sitePath) =>
      fs.readFile(paths.join(root, ...sitePath.split("/"))).pipe(
        Effect.map((bytes) => ({
          path: sitePath,
          contentBase64: bytesToBase64(bytes),
        })),
      ),
    );

    return {
      version: PUBLISH_BUNDLE_VERSION,
      files,
    };
  });
}

/**
 * Recursively lists site paths under root, skipping VCS/dependency directories
 * and the project config file, and rejecting paths the server would refuse.
 */
function collectFiles(
  root: string,
  relativeDir: string,
): Effect.Effect<ReadonlyArray<SitePath>, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const absoluteDir = relativeDir === "" ? root : paths.join(root, ...relativeDir.split("/"));
    const entries = yield* fs.readDirectory(absoluteDir);
    entries.sort((a, b) => a.localeCompare(b));

    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const relativePath = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
        const absolutePath = paths.join(absoluteDir, entry);
        const info = yield* fs.stat(absolutePath);

        if (info.type === "Directory") {
          return SKIPPED_DIRECTORIES.has(entry)
            ? ([] as ReadonlyArray<SitePath>)
            : yield* collectFiles(root, relativePath);
        }
        if (info.type !== "File") return [] as ReadonlyArray<SitePath>;
        if (relativePath === PROJECT_CONFIG_FILE) return [] as ReadonlyArray<SitePath>;
        if (!isSafeSitePath(relativePath)) {
          return yield* Effect.fail(
            new CliError({
              code: 1,
              message: `scratchwork publish: unsupported site path ${relativePath}`,
            }),
          );
        }
        return [relativePath] as ReadonlyArray<SitePath>;
      }),
    );

    return nested.flat();
  });
}

/** POSTs the bundle to /api/publish; 401 becomes PublishAuthRequired for the login retry. */
function postPublish(
  server: string,
  body: {
    readonly bundle: PublishBundle;
    readonly openPath: string;
    readonly workspace?: string;
    readonly project: string;
    readonly visibility?: string;
  },
  authToken: string | undefined,
): Effect.Effect<PublishResponse, CliError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* apiRequest("scratchwork publish", serverApiUrl(server, "/api/publish"), {
      method: "POST",
      token: authToken,
      body,
    });
    if (response.status === 401) {
      return yield* Effect.fail(
        new PublishAuthRequired({
          code: 1,
          message: `scratchwork publish: authentication required. Run \`scratchwork login ${server}\`.`,
        }),
      );
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new CliError({ code: 1, message: `scratchwork publish: ${apiErrorText(response)}` }),
      );
    }
    const parsed = decodePublishResponse(response.json);
    if (parsed == null) {
      return yield* Effect.fail(
        new CliError({ code: 1, message: "scratchwork publish: invalid server response" }),
      );
    }
    return parsed;
  });
}

/**
 * Saves .scratchwork.json next to the published content. Returns whether the
 * save succeeded; a failure prints a warning instead of failing the publish,
 * since the upload itself already went through.
 */
function writeMetadata(
  root: string,
  server: string,
  response: PublishResponse,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> {
  return writeProjectConfig(root, {
    server,
    workspace: response.workspace,
    project: response.project,
    visibility: response.visibility,
    routePath: response.routePath,
    url: response.url,
    updatedAt: new Date().toISOString(),
  }).pipe(
    Effect.as(true),
    Effect.catchAll((error) =>
      Console.error(`scratchwork publish: could not save ${PROJECT_CONFIG_FILE}: ${errorMessage(error)}`).pipe(
        Effect.as(false),
      ),
    ),
  );
}

/** Prints the post-publish summary block. */
function printResult(
  response: PublishResponse,
  bundle: PublishBundle,
  saved: boolean,
): Effect.Effect<void> {
  const bytes = bundle.files.reduce((sum, file) => sum + Math.floor((file.contentBase64.length * 3) / 4), 0);
  return Console.log(
    [
      "\n  scratchwork publish",
      `  url     ${response.url}`,
      `  project ${response.workspace}/${response.project}`,
      `  access  ${response.visibility}`,
      `  files   ${bundle.files.length} (${formatBytes(bytes)})`,
      ...(saved ? [`  saved   ${PROJECT_CONFIG_FILE}\n`] : [""]),
    ].join("\n"),
  );
}

/** Validates and narrows the server's publish response. */
function decodePublishResponse(value: unknown): PublishResponse | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.workspace !== "string" ||
    typeof value.project !== "string" ||
    typeof value.routePath !== "string" ||
    typeof value.visibility !== "string" ||
    typeof value.openPath !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }
  return {
    workspace: value.workspace,
    project: value.project,
    routePath: value.routePath,
    visibility: value.visibility,
    openPath: value.openPath,
    url: value.url,
  };
}

/** Formats a byte count for the summary line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Picks the project name: an explicit or config-file name (validated), or the
 * published directory's name slugified. Publishing a single file requires an
 * explicit name.
 */
function resolveProjectName(
  config: PublishConfig,
  projectConfig: ProjectConfigFile | null,
): Effect.Effect<string, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const explicit = nonEmpty(config.project) ?? nonEmpty(projectConfig?.project);
    if (explicit != null) {
      if (!safeProjectIdentifier(explicit)) {
        return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork publish: invalid project ${explicit}` }));
      }
      return explicit;
    }

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const target = paths.resolve(process.cwd(), config.path);
    const info = yield* fs.stat(target);
    if (info.type === "Directory") return slugifyIdentifier(paths.basename(target), "project");
    return yield* Effect.fail(new CliError({
      code: 1,
      message: "scratchwork publish: --project is required when publishing a file",
    }));
  });
}
