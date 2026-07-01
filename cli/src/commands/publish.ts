import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { bytesToBase64, PUBLISH_BUNDLE_VERSION, type PublishBundle } from "../../../shared/src/publish/bundle";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { readAuthRecord } from "../auth";
import { openBrowser } from "../browser";
import { resolveDevTarget } from "../dev/target";
import { CliError, errorMessage } from "../errors";
import {
  PROJECT_CONFIG_FILE,
  personalWorkspaceForEmail,
  readProjectConfig,
  resolveServer,
  safeIdentifier,
  slugifyIdentifier,
  writeProjectConfig,
  type ProjectConfigFile,
} from "../project-config";
import type { PublishConfig } from "../types";
import { runLogin } from "./login";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".scratchwork-data"]);

interface PublishResponse {
  readonly workspace: string;
  readonly project: string;
  readonly routePath: string;
  readonly visibility: string;
  readonly openPath: string;
  readonly url: string;
}

class PublishAuthRequired extends CliError {}

export function runPublish(
  config: PublishConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const target = yield* resolveDevTarget(config.path ?? ".", "publish");
    const projectConfig = yield* readProjectConfig(target.root);
    const server = yield* resolveServer(config.server, projectConfig, "publish");
    const authRecord = yield* readAuthRecord(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const project = yield* resolveProjectName(config, projectConfig);
    const workspace = nonEmpty(config.workspace)
      ?? nonEmpty(projectConfig?.workspace)
      ?? personalWorkspaceForEmail(authRecord?.email)
      ?? "default";
    const visibility = nonEmpty(config.visibility) ?? nonEmpty(projectConfig?.visibility) ?? "private";

    const bundle = yield* createBundle(target.root);
    let authToken = authRecord?.token;
    const response = yield* postPublish(server, {
      bundle,
      openPath: target.openPath,
      workspace,
      project,
      visibility,
    }, authToken).pipe(
      Effect.catchIf((error) => error instanceof PublishAuthRequired, () =>
        Effect.gen(function* () {
          yield* runLogin({ server });
          const record = yield* readAuthRecord(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          authToken = record?.token;
          const retryWorkspace = nonEmpty(config.workspace)
            ?? nonEmpty(projectConfig?.workspace)
            ?? personalWorkspaceForEmail(record?.email)
            ?? workspace;
          return yield* postPublish(server, {
            bundle,
            openPath: target.openPath,
            workspace: retryWorkspace,
            project,
            visibility,
          }, authToken);
        }),
      ),
    );

    yield* writeMetadata(target.root, server, response).pipe(Effect.catchAll(() => Effect.void));
    yield* printResult(response, bundle);
    yield* openBrowser(response.url);
  });
}

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

function postPublish(
  server: string,
  body: {
    readonly bundle: PublishBundle;
    readonly openPath: string;
    readonly workspace: string;
    readonly project: string;
    readonly visibility: string;
  },
  authToken: string | undefined,
): Effect.Effect<PublishResponse, CliError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(publishEndpoint(server), {
        method: "POST",
        headers: authToken == null
          ? { "content-type": "application/json" }
          : { "authorization": `Bearer ${authToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const json = parseJson(text);
      if (!response.ok) {
        const message = isRecord(json) && typeof json.error === "string" ? json.error : text;
        throw response.status === 401
          ? new PublishAuthRequired({
            code: 1,
            message: `scratchwork publish: authentication required. Run \`scratchwork login ${server}\`.`,
          })
          : new CliError({
            code: 1,
            message: `scratchwork publish: ${message || `server returned ${response.status}`}`,
          });
      }

      const parsed = decodePublishResponse(json);
      if (parsed == null) {
        throw new CliError({
          code: 1,
          message: "scratchwork publish: invalid server response",
        });
      }
      return parsed;
    },
    catch: (error) =>
      error instanceof CliError
        ? error
        : new CliError({
            code: 1,
            message: `scratchwork publish: ${errorMessage(error)}`,
          }),
  });
}

function writeMetadata(
  root: string,
  server: string,
  response: PublishResponse,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    yield* writeProjectConfig(root, {
      server,
      workspace: response.workspace,
      project: response.project,
      visibility: response.visibility,
      routePath: response.routePath,
      url: response.url,
      updatedAt: new Date().toISOString(),
    });
  });
}

function printResult(
  response: PublishResponse,
  bundle: PublishBundle,
): Effect.Effect<void> {
  const bytes = bundle.files.reduce((sum, file) => sum + Math.floor((file.contentBase64.length * 3) / 4), 0);
  return Console.log(
    [
      "\n  scratchwork publish",
      `  url     ${response.url}`,
      `  project ${response.workspace}/${response.project}`,
      `  access  ${response.visibility}`,
      `  files   ${bundle.files.length} (${formatBytes(bytes)})`,
      `  saved   ${PROJECT_CONFIG_FILE}\n`,
    ].join("\n"),
  );
}

function publishEndpoint(server: string): string {
  const url = new URL(server);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/publish`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveProjectName(
  config: PublishConfig,
  projectConfig: ProjectConfigFile | null,
): Effect.Effect<string, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const explicit = nonEmpty(config.project) ?? nonEmpty(projectConfig?.project);
    if (explicit != null) {
      if (!safeIdentifier(explicit)) {
        return yield* Effect.fail(new CliError({ code: 1, message: `scratchwork publish: invalid project ${explicit}` }));
      }
      return explicit;
    }

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const target = paths.resolve(process.cwd(), config.path ?? ".");
    const info = yield* fs.stat(target);
    if (info.type === "Directory") return slugifyIdentifier(paths.basename(target), "project");
    return yield* Effect.fail(new CliError({
      code: 1,
      message: "scratchwork publish: --project is required when publishing a file",
    }));
  });
}
