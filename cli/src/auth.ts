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
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import { sha256Base64Url } from "../../shared/src/crypto/digest";
import { isLoopbackHost } from "../../shared/src/util/url";
import { CliError, errorMessage } from "./errors";

const AUTH_FILE = "auth.json";
const DEFAULT_APP_SUBDOMAIN = "app";

/** One stored login: the bearer token for a server plus who/when it was issued.
 * `cfToken` is the Cloudflare Access JWT relayed by a cloudflare-access server at
 * login; the CLI presents it on API requests so they pass Cloudflare's edge. */
const AuthRecordSchema = Schema.Struct({
  token: Schema.String,
  email: Schema.optionalWith(Schema.String, { nullable: true }),
  cfToken: Schema.optionalWith(Schema.String, { nullable: true }),
  updatedAt: Schema.String,
});

/** One decoded stored login. */
export type AuthRecord = typeof AuthRecordSchema.Type;

/** On-disk shape of auth.json: tokens keyed by normalized server origin. The file
 * is user-editable, so unknown fields are tolerated on read — but the decode drops
 * them, so the next write rewrites the file with only the fields declared here. */
const AuthFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  servers: Schema.Record({ key: Schema.String, value: AuthRecordSchema }),
});

/** The decoded auth.json contents. */
type AuthFile = typeof AuthFileSchema.Type;

/** Decodes the raw auth.json text, tolerating unknown fields. */
const decodeAuthFile = Schema.decodeUnknownEither(Schema.parseJson(AuthFileSchema));

/** The transaction material a login generates before opening the browser: the
 * PKCE verifier (kept local), its S256 challenge (sent to the server), and the
 * state value the loopback callback must echo. The loopback receives only a
 * short-lived one-time code bound to the challenge; the bearer token arrives
 * over the back-channel exchange, never in the callback query string. */
export interface LoginProof {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** One valid loopback callback: the authorization code, or the server-relayed denial. */
export type LoginCallback = { readonly code: string } | { readonly error: string };

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

/** Builds the browser URL that starts a login and redirects back to the local
 * callback, binding the transaction to this CLI instance's state and PKCE challenge. */
export function loginUrl(server: string, callbackUrl: string, proof: LoginProof): string {
  const url = serverApiUrl(server, "/auth/login");
  url.searchParams.set("cli_redirect", callbackUrl);
  url.searchParams.set("cli_state", proof.state);
  url.searchParams.set("cli_code_challenge", proof.codeChallenge);
  return url.toString();
}

/** Generates the per-login PKCE verifier/challenge pair and callback state. */
export function generateLoginProof(): Effect.Effect<LoginProof, CliError> {
  return Effect.gen(function* () {
    const state = yield* Effect.sync(() => randomUrlSafe(16));
    const codeVerifier = yield* Effect.sync(() => randomUrlSafe(32));
    const codeChallenge = yield* Effect.tryPromise({
      try: () => sha256Base64Url(codeVerifier),
      catch: (cause) => new CliError({ code: 1, message: `scratchwork login: ${errorMessage(cause)}` }),
    });
    return { state, codeVerifier, codeChallenge };
  });
}

/** Decodes a loopback callback request. Anything without this login's exact state —
 * a competing local process, a stray request, a mismatched transaction — is null. */
export function decodeLoginCallback(url: URL, expectedState: string): LoginCallback | null {
  if (url.searchParams.get("state") !== expectedState) return null;
  const error = url.searchParams.get("error");
  if (error) return { error: sanitizeLoginError(error) };
  const code = url.searchParams.get("code");
  return code ? { code } : null;
}

/** Keeps a hostile server from injecting terminal controls through the browser
 * callback while preserving conventional OAuth error identifiers. */
function sanitizeLoginError(error: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "provider_error";
}

/** Generates base64url-encoded Web Crypto randomness. */
function randomUrlSafe(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Encoding.encodeBase64Url(buffer);
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
    if (text == null) return { version: 1, servers: {} } as const;
    return yield* decodeAuthFile(text).pipe(
      Effect.mapError(() =>
        new CliError({ code: 1, message: `scratchwork: auth file ${path} is corrupt; fix or remove it` }),
      ),
    );
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
