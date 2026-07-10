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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { bytesToBase64, decodedBase64ByteLength } from "../../../shared/src/encoding/base64";
import {
  PublishResponseSchema,
  type PublishRequestBody,
  type PublishResponse,
} from "../../../shared/src/publish/api";
import { PUBLISH_BUNDLE_VERSION, type PublishBundle } from "../../../shared/src/publish/bundle";
import { isSafeProjectIdentifier, slugifyIdentifier } from "../../../shared/src/site/identifiers";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { nonEmpty } from "../../../shared/src/util/strings";
import { apiErrorText, apiRequest } from "../api";
import { readAuthToken, serverApiUrl } from "../auth";
import { openBrowser } from "../browser";
import { resolveDevTarget, SKIPPED_DIRECTORIES } from "../dev/target";
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

/** Services runPublish needs; exported for callers that wrap it (stream). */
export type PublishServices = CommandExecutor | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path;

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
    const project = yield* resolveProjectName(config, projectConfig, target);
    const nameSource = target.file ?? (yield* basename(target.root));
    // An omitted isPublic preserves an existing project's setting (new projects are
    // created private); an omitted project lets a random-naming server mint one.
    const isPublic = config.isPublic ?? projectConfig?.isPublic;

    const bundle = yield* createBundle(target.root);
    const body: PublishRequestBody = {
      bundle,
      openPath: target.openPath,
      project,
      isPublic,
    };
    const response = yield* postPublish(server, body, authToken).pipe(
      Effect.catchIf((error) => error instanceof PublishAuthRequired, () =>
        Effect.gen(function* () {
          yield* runLogin({ server });
          const refreshed = yield* readAuthToken(server);
          return yield* postPublish(server, body, refreshed);
        }),
      ),
      // The server requires a name we could not derive locally; make the fix obvious.
      Effect.catchIf(
        (error): error is CliError =>
          project == null && error instanceof CliError && error.message.includes("project name is required"),
        () => Effect.fail(new CliError({
          code: 1,
          message: `scratchwork publish: cannot derive a project name from "${nameSource}"; use --project`,
        })),
      ),
    );

    const saved = yield* writeMetadata(target.root, server, response);
    yield* printResult(response, bundle, saved, project);
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
  body: PublishRequestBody,
  authToken: string | undefined,
): Effect.Effect<PublishResponse, CliError, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path> {
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
    // Tolerant decoding on purpose: unknown fields from a newer server are ignored.
    const parsed = Schema.decodeUnknownOption(PublishResponseSchema)(response.json);
    if (Option.isNone(parsed)) {
      return yield* Effect.fail(
        new CliError({ code: 1, message: "scratchwork publish: invalid server response" }),
      );
    }
    return parsed.value;
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
    project: response.project,
    isPublic: response.isPublic,
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

/** Prints the post-publish summary block. The note line is how random-naming users
 * learn their assigned slug (and how a typo'd --project on such a server surfaces). */
function printResult(
  response: PublishResponse,
  bundle: PublishBundle,
  saved: boolean,
  sentProject: string | undefined,
): Effect.Effect<void> {
  const bytes = bundle.files.reduce((sum, file) => sum + (decodedBase64ByteLength(file.contentBase64) ?? 0), 0);
  return Console.log(
    [
      "\n  scratchwork publish",
      `  url     ${response.url}`,
      `  project ${response.project}`,
      ...(sentProject != null && sentProject !== response.project
        ? [`  note    server assigned project name "${response.project}"`]
        : []),
      `  is publicly visible?  ${response.isPublic ? "yes" : "no"}`,
      `  files   ${bundle.files.length} (${formatBytes(bytes)})`,
      ...(saved ? [`  saved   ${PROJECT_CONFIG_FILE}\n`] : [""]),
    ].join("\n"),
  );
}

/** Formats a byte count for the summary line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Picks the project name, highest precedence first: an explicit --project (validated,
 * never slugified), the publish root's saved config, or a derived default — the
 * directory basename, or the file basename minus its final extension for a file
 * target. When nothing usable can be derived, returns undefined so no name is sent:
 * a random-naming server mints one, and a user-naming server's 400 is mapped to a
 * "use --project" error in runPublish. Never fall back to a fixed name — under global
 * uniqueness a shared literal would make unrelated projects republish over each other.
 */
function resolveProjectName(
  config: PublishConfig,
  projectConfig: ProjectConfigFile | null,
  target: { readonly root: string; readonly file?: string },
): Effect.Effect<string | undefined, CliError, Path.Path> {
  return Effect.gen(function* () {
    const explicit = nonEmpty(config.project) ?? nonEmpty(projectConfig?.project);
    if (explicit != null) {
      if (!isSafeProjectIdentifier(explicit)) {
        return yield* Effect.fail(new CliError({
          code: 1,
          message: `scratchwork publish: invalid project ${explicit} (lowercase letters, digits, ".", "_", "-"; must start and end with a letter or digit)`,
        }));
      }
      return explicit;
    }

    const derived = target.file != null ? fileStem(target.file) : yield* basename(target.root);
    return nonEmpty(slugifyIdentifier(derived, ""));
  });
}

/** Strips a filename's final extension: the substring after the last ".", unless that
 * dot leads the name or no stem would remain ("notes.md" -> "notes", "data.tar.gz" ->
 * "data.tar", ".env" -> ".env"). Deliberately not openPathForFile, which strips only
 * .html/.md because it builds a servable route, not a name. */
function fileStem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Reads a path's basename through the Path service. */
function basename(value: string): Effect.Effect<string, never, Path.Path> {
  return Effect.map(Path.Path, (paths) => paths.basename(value));
}
