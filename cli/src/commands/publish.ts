import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { bytesToBase64, PUBLISH_BUNDLE_VERSION, type PublishBundle } from "../../../shared/src/publish/bundle";
import { isSafeSitePath, type SitePath } from "../../../shared/src/site/paths";
import { normalizeServerUrl, readAuthToken } from "../auth";
import { resolveDevTarget } from "../dev/target";
import { CliError, errorMessage } from "../errors";
import type { PublishConfig } from "../types";

const DEFAULT_SERVER = "http://localhost:3001";
const METADATA_FILE = ".scratchwork.json";
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".scratchwork-data"]);

interface PublishMetadata {
  readonly server: string;
  readonly slug: string;
  readonly token: string;
  readonly url: string;
  readonly updatedAt: string;
}

interface PublishResponse {
  readonly slug: string;
  readonly token: string;
  readonly url: string;
}

export function runPublish(
  config: PublishConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const target = yield* resolveDevTarget(config.path ?? ".", "publish");
    const metadata = yield* readMetadata(target.root);
    const server = normalizeServerUrl(
      nonEmpty(config.server) ??
        nonEmpty(process.env.SCRATCHWORK_SERVER_URL) ??
        metadata?.server ??
        DEFAULT_SERVER,
    );
    const reusableMetadata = metadata?.server === server ? metadata : null;
    const slug = nonEmpty(config.slug) ?? reusableMetadata?.slug;
    const token = nonEmpty(config.token) ?? reusableMetadata?.token;

    if ((slug == null) !== (token == null)) {
      return yield* Effect.fail(
        new CliError({
          code: 1,
          message: "scratchwork publish: --slug and --token must be provided together",
        }),
      );
    }

    const bundle = yield* createBundle(target.root);
    const authToken = yield* readAuthToken(server).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const response = yield* postPublish(server, {
      bundle,
      openPath: target.openPath,
      slug,
      token,
    }, authToken);

    yield* writeMetadata(target.root, server, response).pipe(Effect.catchAll(() => Effect.void));
    yield* printResult(response, bundle);
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
        if (relativePath === METADATA_FILE) return [] as ReadonlyArray<SitePath>;
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
    readonly slug?: string;
    readonly token?: string;
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
        throw new CliError({
          code: 1,
          message: response.status === 401
            ? `scratchwork publish: authentication required. Run \`scratchwork login --server ${server}\`.`
            : `scratchwork publish: ${message || `server returned ${response.status}`}`,
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

function readMetadata(
  root: string,
): Effect.Effect<PublishMetadata | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const path = paths.join(root, METADATA_FILE);
    if (!(yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false))))) return null;

    const text = yield* fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));
    const metadata = decodeMetadata(parseJson(text));
    return metadata;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function writeMetadata(
  root: string,
  server: string,
  response: PublishResponse,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const metadata: PublishMetadata = {
      server,
      slug: response.slug,
      token: response.token,
      url: response.url,
      updatedAt: new Date().toISOString(),
    };
    yield* fs.writeFileString(paths.join(root, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
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
      `  slug    ${response.slug}`,
      `  token   ${response.token}`,
      `  files   ${bundle.files.length} (${formatBytes(bytes)})`,
      `  saved   ${METADATA_FILE}\n`,
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
  if (typeof value.slug !== "string" || typeof value.token !== "string" || typeof value.url !== "string") {
    return null;
  }
  return { slug: value.slug, token: value.token, url: value.url };
}

function decodeMetadata(value: unknown): PublishMetadata | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.server !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.token !== "string" ||
    typeof value.url !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  const server = tryNormalizeServerUrl(value.server);
  if (server == null) return null;
  return {
    server,
    slug: value.slug,
    token: value.token,
    url: value.url,
    updatedAt: value.updatedAt,
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

function tryNormalizeServerUrl(value: string): string | null {
  try {
    return normalizeServerUrl(value);
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
