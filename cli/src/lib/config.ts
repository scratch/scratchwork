/*
 * CLI configuration + credentials, kept deliberately small.
 *
 *   ~/.config/scratchwork/credentials.json   per-server credentials (mode 0600)
 *   ~/.config/scratchwork/config.json        global defaults (e.g. server)
 *
 * A credentials entry is { token, type?, cfToken?, user? }:
 *   - type "session"  → sent as Authorization: Bearer (browser/device login)
 *   - type "api_key"  → sent as X-Api-Key (CI/env tokens)
 *   - legacy entries (just { token }) are treated as bearer, so old single-token
 *     servers keep working.
 *
 * File IO is modeled through Effect's FileSystem service so commands stay
 * testable and composable with the rest of the CLI runtime.
 */
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Auth, User } from "../types";

export const DEFAULT_SERVER = "https://scratchwork.dev";

export interface StoredCredentials extends Auth {
  readonly user?: Pick<User, "id" | "email" | "name">;
}

export interface GlobalConfig {
  readonly server?: string;
}

type JsonObject = Record<string, unknown>;

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "scratchwork");
}

const credentialsPath = () => join(configDir(), "credentials.json");
const globalConfigPath = () => join(configDir(), "config.json");

// Trailing-slash- and case-insensitive key for a server URL.
export function normalizeServerUrl(url: string | null | undefined): string {
  return String(url || "").replace(/\/+$/, "").toLowerCase();
}

function readJson(path: string): Effect.Effect<unknown | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (text == null) return null;
    return parseJson(text);
  });
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonSecure(
  path: string,
  data: unknown,
  mode?: number,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(configDir(), { recursive: true });
    // Pass mode to writeFileString so a NEW file is created with restricted
    // permissions atomically (no world-readable window). chmod afterward covers
    // the case where the file already existed with looser permissions.
    yield* fs.writeFileString(
      path,
      JSON.stringify(data, null, 2),
      mode ? { mode } : undefined,
    );
    if (mode) {
      yield* fs.chmod(path, mode).pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  return isObject(value) && typeof value.token === "string";
}

// ---- credentials ------------------------------------------------------------

export function loadCredentials(
  serverUrl: string,
): Effect.Effect<StoredCredentials | null, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const all = yield* readJson(credentialsPath());
    if (!isObject(all)) return null;
    const entry = all[normalizeServerUrl(serverUrl)];
    return isStoredCredentials(entry) ? entry : null;
  });
}

export function saveCredentials(
  serverUrl: string,
  entry: StoredCredentials,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const all = yield* readJson(credentialsPath());
    const next: Record<string, unknown> = isObject(all) ? { ...all } : {};
    next[normalizeServerUrl(serverUrl)] = entry;
    yield* writeJsonSecure(credentialsPath(), next, 0o600);
  });
}

export function clearCredentials(
  serverUrl: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const all = yield* readJson(credentialsPath());
    if (!isObject(all)) return;
    const key = normalizeServerUrl(serverUrl);
    if (!(key in all)) return;

    const next = { ...all };
    delete next[key];
    yield* writeJsonSecure(credentialsPath(), next, 0o600);
  });
}

// Full auth to use for a server: { token, type, cfToken } or null. The env var
// wins (CI). An env token prefixed "scratchwork_" is an API key (X-Api-Key);
// anything else is a legacy/session bearer token. Stored creds carry their type.
export function resolveAuth(
  serverUrl: string,
): Effect.Effect<Auth | null, never, FileSystem.FileSystem> {
  const envTok = process.env.SCRATCHWORK_TOKEN;
  if (envTok) {
    return Effect.succeed({
      token: envTok,
      type: envTok.startsWith("scratchwork_") ? "api_key" : "bearer",
    });
  }
  return loadCredentials(serverUrl).pipe(
    Effect.map((creds) =>
      creds
        ? { token: creds.token, type: creds.type || "bearer", cfToken: creds.cfToken }
        : null,
    ),
  );
}

// ---- global config ----------------------------------------------------------

export function loadGlobalConfig(): Effect.Effect<GlobalConfig, never, FileSystem.FileSystem> {
  return readJson(globalConfigPath()).pipe(
    Effect.map((cfg) => (isObject(cfg) ? { server: typeof cfg.server === "string" ? cfg.server : undefined } : {})),
  );
}

export function saveGlobalConfig(
  cfg: GlobalConfig,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return writeJsonSecure(globalConfigPath(), cfg);
}

// Resolve the server URL by priority:
//   1. explicit flag  2. global default  3. DEFAULT_SERVER
export function resolveServerUrl({
  flag,
}: { readonly flag?: string | null } = {}): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem
> {
  if (flag) return Effect.succeed(flag.replace(/\/+$/, ""));
  return loadGlobalConfig().pipe(
    Effect.map((cfg) =>
      cfg.server ? String(cfg.server).replace(/\/+$/, "") : DEFAULT_SERVER,
    ),
  );
}
