import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { normalizeAccessGroup, type AccessGroup } from "./access";

export type EnvVars = Readonly<Record<string, string | undefined>>;

export interface ServerConfigShape {
  readonly port: number;
  readonly appUrl?: string;
  readonly contentUrl?: string;
  /** @deprecated Use appUrl/contentUrl. */
  readonly publicUrl?: string;
  readonly maxVisibility: AccessGroup;
  readonly shareAllowedDomains: ReadonlySet<string>;
  readonly projectPath: ProjectPathStrategy;
  readonly defaultWorkspace: DefaultWorkspaceStrategy;
  readonly defaultVisibility: AccessGroup;
  readonly auth: AuthConfig;
}

export type ProjectPathStrategy =
  | "workspace/project"
  | "domain/username/project"
  | "username/project"
  | "random";

export type DefaultWorkspaceStrategy = "personal" | "random" | "required";

export interface AuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly allowedUsers: AccessGroup;
  readonly sessionTtlSeconds: number;
}

export class ServerConfig extends Context.Tag("@scratchwork/server/Config")<
  ServerConfig,
  ServerConfigShape
>() {}

export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string;
}> {}

/** Builds a ServerConfig layer from an explicit environment map. */
export function makeServerConfigLayer(
  env: EnvVars,
): Layer.Layer<ServerConfig, ServerConfigError> {
  return Layer.effect(ServerConfig, readServerConfig(env));
}

export const ServerConfigLive: Layer.Layer<ServerConfig, ServerConfigError> =
  makeServerConfigLayer(readProcessEnv());

/** Parses all server runtime configuration from environment variables. */
export function readServerConfig(
  env: EnvVars,
): Effect.Effect<ServerConfigShape, ServerConfigError> {
  return Effect.gen(function* () {
    const port = parsePort(env.PORT ?? env.SCRATCHWORK_PORT ?? "3001");
    if (port == null) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "PORT must be an integer between 1 and 65535",
        }),
      );
    }

    return {
      port,
      publicUrl: yield* readPublicUrl(env.SCRATCHWORK_PUBLIC_URL),
      appUrl: yield* readPublicUrl(env.SCRATCHWORK_APP_URL ?? urlFromDomain(env.SCRATCHWORK_APP_DOMAIN) ?? env.SCRATCHWORK_PUBLIC_URL),
      contentUrl: yield* readPublicUrl(env.SCRATCHWORK_CONTENT_URL ?? urlFromDomain(env.SCRATCHWORK_CONTENT_DOMAIN) ?? env.SCRATCHWORK_PUBLIC_URL),
      maxVisibility: yield* readAccessGroup(env.SCRATCHWORK_MAX_VISIBILITY, "public", "SCRATCHWORK_MAX_VISIBILITY"),
      shareAllowedDomains: domainSet(env.SCRATCHWORK_SHARE_ALLOWED_DOMAINS),
      projectPath: yield* readProjectPath(env.SCRATCHWORK_PROJECT_PATH),
      defaultWorkspace: readDefaultWorkspace(env.SCRATCHWORK_DEFAULT_WORKSPACE),
      defaultVisibility: yield* readAccessGroup(env.SCRATCHWORK_DEFAULT_VISIBILITY, "private", "SCRATCHWORK_DEFAULT_VISIBILITY"),
      auth: yield* readAuthConfig(env),
    };
  });
}

/** Validates and normalizes the configured public origin. */
function readPublicUrl(value: string | undefined): Effect.Effect<string | undefined, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed(undefined);
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return Effect.fail(new ServerConfigError({ message: "SCRATCHWORK_PUBLIC_URL must be an origin, such as https://example.com" }));
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return Effect.fail(new ServerConfigError({ message: "SCRATCHWORK_PUBLIC_URL must use https, except loopback http for local development" }));
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(new ServerConfigError({ message: "SCRATCHWORK_PUBLIC_URL must be a valid URL" }));
  }
}

/** Parses required OAuth settings from environment variables. Auth cannot be disabled. */
function readAuthConfig(env: EnvVars): Effect.Effect<AuthConfig, ServerConfigError> {
  return Effect.gen(function* () {
    const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
    const clientId = env.SCRATCHWORK_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
    const clientSecret = env.SCRATCHWORK_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
    const sessionSecret = env.SCRATCHWORK_SESSION_SECRET;

    if (authMode !== "" && authMode !== "oauth") {
      return yield* Effect.fail(new ServerConfigError({ message: "SCRATCHWORK_AUTH must be \"oauth\" when set" }));
    }
    if (!clientId || !clientSecret || !sessionSecret) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "OAuth is required: set SCRATCHWORK_GOOGLE_CLIENT_ID, SCRATCHWORK_GOOGLE_CLIENT_SECRET, and SCRATCHWORK_SESSION_SECRET",
        }),
      );
    }
    if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "SCRATCHWORK_SESSION_SECRET must be at least 32 bytes",
        }),
      );
    }

    return {
      clientId,
      clientSecret,
      sessionSecret,
      allowedUsers: yield* readAccessGroup(
        env.SCRATCHWORK_ALLOWED_USERS ?? groupFromLegacyAuthAllowLists(env.SCRATCHWORK_AUTH_ALLOWED_EMAILS, env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS),
        "public",
        "SCRATCHWORK_ALLOWED_USERS",
      ),
      sessionTtlSeconds: parsePositiveInteger(env.SCRATCHWORK_AUTH_SESSION_SECONDS) ?? 60 * 60 * 24 * 30,
    } as const;
  });
}

function readAccessGroup(
  value: string | undefined,
  fallback: string,
  name: string,
): Effect.Effect<AccessGroup, ServerConfigError> {
  return normalizeAccessGroup(value == null || value === "" ? fallback : value).pipe(
    Effect.mapError((cause) => new ServerConfigError({ message: `${name}: ${cause.message}` })),
  );
}

function readProjectPath(value: string | undefined): Effect.Effect<ProjectPathStrategy, ServerConfigError> {
  const projectPath = value == null || value === "" ? "random" : value;
  if (
    projectPath === "workspace/project" ||
    projectPath === "domain/username/project" ||
    projectPath === "username/project" ||
    projectPath === "random"
  ) {
    return Effect.succeed(projectPath);
  }
  return Effect.fail(
    new ServerConfigError({
      message: "SCRATCHWORK_PROJECT_PATH must be workspace/project, domain/username/project, username/project, or random",
    }),
  );
}

function readDefaultWorkspace(value: string | undefined): DefaultWorkspaceStrategy {
  if (value === "random") return "random";
  if (value === "") return "required";
  return "personal";
}

function urlFromDomain(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return value.includes("://") ? value : `https://${value}`;
}

function groupFromLegacyAuthAllowLists(emails: string | undefined, domains: string | undefined): string | undefined {
  const parts = [
    ...csvItems(emails),
    ...csvItems(domains).map((domain) => domain.startsWith("@") ? domain : `@${domain}`),
  ];
  return parts.length === 0 ? undefined : parts.join(",");
}

/** Reads process.env when available without assuming a Node-like global. */
function readProcessEnv(): EnvVars {
  const processLike = globalThis as typeof globalThis & {
    readonly process?: { readonly env?: EnvVars };
  };
  return processLike.process?.env ?? {};
}

/** Parses a valid TCP port number. */
function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Parses an optional positive integer environment value. */
function parsePositiveInteger(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Converts a comma-separated allow-list to a lowercase set. */
function domainSet(value: string | undefined): ReadonlySet<string> {
  return new Set(csvItems(value).map((domain) => domain.replace(/^@/, "").toLowerCase()));
}

function csvItems(value: string | undefined): ReadonlyArray<string> {
  if (value == null || value === "") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}
