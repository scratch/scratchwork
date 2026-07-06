/*
 * Server URLs and stored login credentials.
 *
 * Normalizes user-supplied server strings into canonical origins, builds
 * server API/auth URLs, and reads/writes the per-server bearer tokens kept in
 * $SCRATCHWORK_HOME/auth.json (default ~/.scratchwork/auth.json).
 */
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import { nonEmpty } from "../../shared/src/util/strings";
import { isLoopbackHost } from "../../shared/src/util/url";
import { isRecord, parseJson } from "../../shared/src/util/json";
import { CliError, errorMessage } from "./errors";

const AUTH_FILE = "auth.json";
const DEFAULT_APP_SUBDOMAIN = "app";

/** One stored login: the bearer token for a server plus who/when it was issued.
 * `cfToken` is the Cloudflare Access JWT relayed by a cloudflare-access server at
 * login; the CLI presents it on API requests so they pass Cloudflare's edge. */
export interface AuthRecord {
  readonly token: string;
  readonly email?: string;
  readonly cfToken?: string;
  readonly updatedAt: string;
}

/** On-disk shape of auth.json: tokens keyed by normalized server origin. */
interface AuthFile {
  readonly version: 1;
  readonly servers: Record<string, AuthRecord>;
}

/** Query parameters delivered to the local login callback by the server. */
export interface LoginCallback {
  readonly token: string;
  readonly email?: string;
  readonly server?: string;
  readonly cfToken?: string;
}

/**
 * Looks up the stored bearer token for a server.
 *
 * Content URLs (`https://pages.example.com/...`) name a different origin than
 * the app server the user logged in to, so on a miss this also tries the
 * `app.<parent>` and naked-parent origins of the same domain.
 */
export function readAuthToken(
  server: string,
): Effect.Effect<string | undefined, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const auth = yield* readAuthFile();
    for (const candidate of candidateServers(server)) {
      const record = auth.servers[candidate];
      if (record != null) return record.token;
    }
    return undefined;
  });
}

/** Looks up the stored Cloudflare Access JWT for a server, with the same origin
 * fallbacks as readAuthToken. Undefined for servers that did not relay one. */
export function readCfToken(
  server: string,
): Effect.Effect<string | undefined, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const auth = yield* readAuthFile();
    for (const candidate of candidateServers(server)) {
      const cfToken = auth.servers[candidate]?.cfToken;
      if (cfToken != null) return cfToken;
    }
    return undefined;
  });
}

/** Saves a bearer token for a server, preserving tokens stored for other servers. */
export function writeAuthToken(
  server: string,
  token: string,
  email: string | undefined,
  cfToken?: string,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const path = yield* authFilePath();
    const auth = yield* readAuthFile();
    const next: AuthFile = {
      version: 1,
      servers: {
        ...auth.servers,
        [server]: {
          token,
          email,
          cfToken,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, `${JSON.stringify(next, null, 2)}\n`);
  });
}

/**
 * Canonicalizes a user-supplied server string into an origin URL: adds a
 * scheme (http for local hosts, https otherwise), promotes naked public
 * domains to their app subdomain (`sndbx.sh` -> `https://app.sndbx.sh`), and
 * strips query, hash, and trailing slashes.
 */
export function normalizeServerUrl(value: string): string {
  const input = value.trim();
  const url = new URL(hasScheme(input) ? input : `${defaultScheme(input)}://${input}`);
  if (isNakedPublicHost(url.hostname)) url.hostname = `${DEFAULT_APP_SUBDOMAIN}.${url.hostname}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Joins an API/auth path onto a server URL, preserving any path prefix the
 * server is mounted under (`https://host/scratchwork` + `/api/me` ->
 * `https://host/scratchwork/api/me`).
 */
export function serverApiUrl(server: string, path: string): URL {
  const url = new URL(server);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

/** Builds the browser URL that starts a login and redirects back to the local callback. */
export function loginUrl(server: string, callbackUrl: string): string {
  const url = serverApiUrl(server, "/auth/login");
  url.searchParams.set("cli_redirect", callbackUrl);
  return url.toString();
}

/** Decodes the login callback query parameters, or returns null when no token is present. */
export function decodeLoginCallback(url: URL): LoginCallback | null {
  const token = url.searchParams.get("token");
  if (!token) return null;
  return {
    token,
    email: nonEmpty(url.searchParams.get("email") ?? undefined),
    server: nonEmpty(url.searchParams.get("server") ?? undefined),
    cfToken: nonEmpty(url.searchParams.get("cf_token") ?? undefined),
  };
}

/**
 * Reads and validates auth.json. A missing file is an empty auth store; an
 * unreadable or malformed file is a CliError, so a corrupted store is never
 * silently treated as logged-out (and then wiped by the next login).
 */
function readAuthFile(): Effect.Effect<AuthFile, CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* authFilePath();
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error._tag === "SystemError" && error.reason === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((error) =>
        new CliError({ code: 1, message: `scratchwork: auth file ${path} is unreadable (${errorMessage(error)}); fix or remove it` }),
      ),
    );
    if (text == null) return { version: 1, servers: {} };
    const parsed = parseJson(text);
    if (!isAuthFile(parsed)) {
      return yield* Effect.fail(
        new CliError({ code: 1, message: `scratchwork: auth file ${path} is corrupt; fix or remove it` }),
      );
    }
    return parsed;
  });
}

/** Resolves the auth.json path under SCRATCHWORK_HOME or ~/.scratchwork. */
function authFilePath(): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const scratchworkHome = process.env.SCRATCHWORK_HOME ?? paths.join(homedir(), ".scratchwork");
    return paths.join(scratchworkHome, AUTH_FILE);
  });
}

/**
 * Origins to try when looking up a token: the server itself, then — for
 * three-plus-label hosts like pages.example.com — the app subdomain and naked
 * origin of the parent domain, which is where `scratchwork login` stores them.
 */
function candidateServers(server: string): ReadonlyArray<string> {
  const candidates = [server];
  try {
    const url = new URL(server);
    const labels = url.hostname.split(".");
    if (labels.length >= 3) {
      const parent = labels.slice(1).join(".");
      for (const host of [`${DEFAULT_APP_SUBDOMAIN}.${parent}`, parent]) {
        const candidate = new URL(server);
        candidate.hostname = host;
        candidate.pathname = "";
        candidates.push(candidate.toString().replace(/\/+$/, ""));
      }
    }
  } catch {
    /* not a URL; look up the literal key only */
  }
  return [...new Set(candidates)];
}

/** Validates the parsed shape of auth.json. */
function isAuthFile(value: unknown): value is AuthFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) return false;
  for (const record of Object.values(value.servers)) {
    if (!isRecord(record) || typeof record.token !== "string" || typeof record.updatedAt !== "string") return false;
    if (record.email != null && typeof record.email !== "string") return false;
    if (record.cfToken != null && typeof record.cfToken !== "string") return false;
  }
  return true;
}

/** Checks whether a server string already carries an explicit URL scheme. */
function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/** Picks http for local development hosts and https for everything else. */
function defaultScheme(value: string): "http" | "https" {
  return isLoopbackHost(hostFromServer(value)) ? "http" : "https";
}

/** Matches bare two-label public hosts that should gain the app subdomain. */
function isNakedPublicHost(host: string): boolean {
  return /^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/.test(host);
}

/** Extracts the hostname from a scheme-less server string, including IPv6 brackets. */
function hostFromServer(value: string): string {
  const authority = value.split(/[/?#]/, 1)[0] ?? "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(1, end);
  }
  return authority.split(":", 1)[0] ?? "";
}
