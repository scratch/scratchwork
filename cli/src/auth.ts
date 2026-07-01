import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import { CliError } from "./errors";

const AUTH_FILE = "auth.json";
const DEFAULT_APP_SUBDOMAIN = "www";

interface AuthRecord {
  readonly token: string;
  readonly email?: string;
  readonly updatedAt: string;
}

interface AuthFile {
  readonly version: 1;
  readonly servers: Record<string, AuthRecord>;
}

export function readAuthToken(
  server: string,
): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const auth = yield* readAuthFile();
    return auth.servers[server]?.token;
  });
}

export function writeAuthToken(
  server: string,
  token: string,
  email: string | undefined,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
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
          updatedAt: new Date().toISOString(),
        },
      },
    };
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, `${JSON.stringify(next, null, 2)}\n`);
  });
}

export function normalizeServerUrl(value: string): string {
  const input = value.trim();
  const url = new URL(hasScheme(input) ? input : `${defaultScheme(input)}://${input}`);
  if (isNakedPublicHost(url.hostname)) url.hostname = `${DEFAULT_APP_SUBDOMAIN}.${url.hostname}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function defaultServerUrl(value: string | undefined): string {
  return normalizeServerUrl(nonEmpty(value) ?? nonEmpty(process.env.SCRATCHWORK_SERVER_URL) ?? "http://localhost:3001");
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}

export function loginUrl(server: string, callbackUrl: string): string {
  const url = new URL("/auth/login", server);
  url.searchParams.set("cli_redirect", callbackUrl);
  return url.toString();
}

export function decodeLoginCallback(url: URL): { readonly token: string; readonly email?: string; readonly server?: string } {
  const token = url.searchParams.get("token");
  if (!token) throw new CliError({ code: 1, message: "scratchwork login: missing auth token" });
  return {
    token,
    email: nonEmpty(url.searchParams.get("email") ?? undefined),
    server: nonEmpty(url.searchParams.get("server") ?? undefined),
  };
}

function readAuthFile(): Effect.Effect<AuthFile, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* authFilePath();
    const text = yield* fs.readFileString(path).pipe(Effect.catchAll(() => Effect.succeed("")));
    const parsed = parseJson(text);
    return isAuthFile(parsed) ? parsed : { version: 1, servers: {} };
  });
}

function authFilePath(): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const configRoot = process.env.XDG_CONFIG_HOME ?? paths.join(homeDirectory(), ".config");
    return paths.join(configRoot, "scratchwork", AUTH_FILE);
  });
}

function homeDirectory(): string {
  return process.env.HOME ?? process.cwd();
}

function isAuthFile(value: unknown): value is AuthFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) return false;
  for (const record of Object.values(value.servers)) {
    if (!isRecord(record) || typeof record.token !== "string" || typeof record.updatedAt !== "string") return false;
    if (record.email != null && typeof record.email !== "string") return false;
  }
  return true;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

function defaultScheme(value: string): "http" | "https" {
  const host = hostFromServer(value).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" ? "http" : "https";
}

function isNakedPublicHost(host: string): boolean {
  return /^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/.test(host);
}

function hostFromServer(value: string): string {
  const authority = value.split(/[/?#]/, 1)[0] ?? "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(1, end);
  }
  return authority.split(":", 1)[0] ?? "";
}
