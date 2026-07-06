import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nonEmpty } from "../../../shared/src/util/strings";
import { isLoopbackHost } from "../../../shared/src/util/url";
import { normalizeAccessGroup, safeDomain, type AccessGroup } from "./access";

/** An environment-variable map from any platform (process.env, Worker vars, Lambda env). */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/** Parsed server configuration. */
export interface ServerConfigShape {
  readonly port: number;
  /** Public origin of the app host (auth routes and API), when configured. */
  readonly appUrl?: string;
  /** Public origin of the content host (published sites), when configured. */
  readonly contentUrl?: string;
  /** Server-wide ceiling on how visible any project may be. */
  readonly maxVisibility: AccessGroup;
  /** When non-empty, explicit share targets must fall inside these domains. */
  readonly shareAllowedDomains: ReadonlySet<string>;
  /** true: publishers choose globally-unique project names (first-writer-wins).
   * false: the server assigns a random slug on first publish. */
  readonly usersCanSetProjectNames: boolean;
  /** Visibility applied when a publish does not specify one. */
  readonly defaultVisibility: AccessGroup;
  readonly auth: AuthConfig;
}

/** Google OAuth and session-signing settings. Auth cannot be disabled. */
export interface AuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly allowedUsers: AccessGroup;
  readonly sessionTtlSeconds: number;
}

/** Service tag for server configuration. */
export class ServerConfig extends Context.Tag("@scratchwork/server/Config")<
  ServerConfig,
  ServerConfigShape
>() {}

/** Raised when environment configuration is missing or malformed. */
export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string;
}> {}

/** Builds the uniform rejection for one env var: the value given and what is accepted. */
function invalidValue(name: string, value: string, expected: string): ServerConfigError {
  return new ServerConfigError({ message: `Invalid ${name} "${value}": expected ${expected}` });
}

/** Builds a ServerConfig layer from an explicit environment map. */
export function makeServerConfigLayer(
  env: EnvVars,
): Layer.Layer<ServerConfig, ServerConfigError> {
  return Layer.effect(ServerConfig, readServerConfig(env));
}

/** Parses all server runtime configuration from environment variables. */
export function readServerConfig(
  env: EnvVars,
): Effect.Effect<ServerConfigShape, ServerConfigError> {
  return Effect.gen(function* () {
    const portValue = env.PORT ?? env.SCRATCHWORK_PORT ?? "3001";
    const port = parsePort(portValue);
    if (port == null) {
      return yield* Effect.fail(invalidValue("PORT", portValue, 'an integer between 1 and 65535, like "3001"'));
    }

    return {
      port,
      appUrl: yield* readPublicUrl(
        nonEmpty(env.SCRATCHWORK_APP_URL) ?? urlFromDomain(env.SCRATCHWORK_APP_DOMAIN),
        "SCRATCHWORK_APP_URL",
      ),
      contentUrl: yield* readPublicUrl(
        nonEmpty(env.SCRATCHWORK_CONTENT_URL) ?? urlFromDomain(env.SCRATCHWORK_CONTENT_DOMAIN),
        "SCRATCHWORK_CONTENT_URL",
      ),
      maxVisibility: yield* readAccessGroup(env.SCRATCHWORK_MAX_VISIBILITY, "public", "SCRATCHWORK_MAX_VISIBILITY"),
      shareAllowedDomains: yield* readDomainSet(env.SCRATCHWORK_SHARE_ALLOWED_DOMAINS, "SCRATCHWORK_SHARE_ALLOWED_DOMAINS"),
      usersCanSetProjectNames: yield* readBoolean(env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES, true, "SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES"),
      defaultVisibility: yield* readBinaryVisibility(env.SCRATCHWORK_DEFAULT_VISIBILITY, "private", "SCRATCHWORK_DEFAULT_VISIBILITY"),
      auth: yield* readAuthConfig(env),
    };
  });
}

/** Validates and normalizes one configured public origin (appUrl or contentUrl). */
function readPublicUrl(value: string | undefined, name: string): Effect.Effect<string | undefined, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed(undefined);
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return Effect.fail(invalidValue(name, value, 'a bare origin with no path, query, or fragment, like "https://example.com"'));
    }
    // Loopback (including *.localhost, which resolves locally on modern systems)
    // may use http so local runs get real hostname-per-role URLs.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return Effect.fail(invalidValue(name, value, 'an https URL, like "https://example.com" (plain http is allowed only for loopback hosts, like "http://localhost:3001")'));
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(invalidValue(name, value, 'a URL, like "https://example.com"'));
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
      return yield* Effect.fail(invalidValue("SCRATCHWORK_AUTH", authMode, '"oauth" (the only supported mode), or leave it unset'));
    }
    if (!clientId || !clientSecret || !sessionSecret) {
      const missing = [
        clientId ? null : "SCRATCHWORK_GOOGLE_CLIENT_ID",
        clientSecret ? null : "SCRATCHWORK_GOOGLE_CLIENT_SECRET",
        sessionSecret ? null : "SCRATCHWORK_SESSION_SECRET",
      ].filter((name) => name != null);
      return yield* Effect.fail(
        new ServerConfigError({
          message: `OAuth is required: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Create OAuth credentials at https://console.cloud.google.com/apis/credentials and generate a session secret with "openssl rand -hex 32".`,
        }),
      );
    }
    if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: 'SCRATCHWORK_SESSION_SECRET must be at least 32 bytes: generate one with "openssl rand -hex 32"',
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
      sessionTtlSeconds: yield* readPositiveInteger(
        env.SCRATCHWORK_AUTH_SESSION_SECONDS,
        60 * 60 * 24 * 30,
        "SCRATCHWORK_AUTH_SESSION_SECONDS",
      ),
    } as const;
  });
}

/** Parses a visibility-toggle environment value: project visibility is only ever public
 * or private (per-account access is a grant list managed through share, not a visibility
 * value). */
function readBinaryVisibility(
  value: string | undefined,
  fallback: "public" | "private",
  name: string,
): Effect.Effect<AccessGroup, ServerConfigError> {
  const visibility = value == null || value === "" ? fallback : value.trim().toLowerCase();
  if (visibility !== "public" && visibility !== "private") {
    return Effect.fail(invalidValue(name, value ?? "", '"public" or "private" (per-account access is granted through share, not a visibility value)'));
  }
  return Effect.succeed(visibility);
}

/** Parses one access-group environment value with a fallback expression. */
function readAccessGroup(
  value: string | undefined,
  fallback: string,
  name: string,
): Effect.Effect<AccessGroup, ServerConfigError> {
  return normalizeAccessGroup(value == null || value === "" ? fallback : value).pipe(
    Effect.mapError((cause) => new ServerConfigError({ message: `${name}: ${cause.message}` })),
  );
}

/** Parses one boolean environment value with a fallback. */
function readBoolean(value: string | undefined, fallback: boolean, name: string): Effect.Effect<boolean, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed(fallback);
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return Effect.succeed(true);
  if (normalized === "false") return Effect.succeed(false);
  return Effect.fail(invalidValue(name, value, '"true" or "false"'));
}

/** Expands a bare domain env value into an https origin. */
function urlFromDomain(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return value.includes("://") ? value : `https://${value}`;
}

/** Folds the legacy SCRATCHWORK_AUTH_ALLOWED_EMAILS/_DOMAINS variables into one expression. */
function groupFromLegacyAuthAllowLists(emails: string | undefined, domains: string | undefined): string | undefined {
  const parts = [
    ...csvItems(emails),
    ...csvItems(domains).map((domain) => domain.startsWith("@") ? domain : `@${domain}`),
  ];
  return parts.length === 0 ? undefined : parts.join(",");
}

/** Parses a valid TCP port number. */
function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Parses one positive-integer environment value with a fallback. */
function readPositiveInteger(value: string | undefined, fallback: number, name: string): Effect.Effect<number, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed(fallback);
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return Effect.succeed(number);
  return Effect.fail(invalidValue(name, value, 'a positive integer number of seconds, like "86400"'));
}

/** Parses a comma-separated domain allow-list environment value into a lowercase set. */
function readDomainSet(value: string | undefined, name: string): Effect.Effect<ReadonlySet<string>, ServerConfigError> {
  const domains = csvItems(value).map((domain) => domain.replace(/^@/, ""));
  if (domains.some((domain) => !safeDomain(domain))) {
    return Effect.fail(invalidValue(name, value ?? "", 'a comma-separated list of domains, like "example.com,corp.example.com"'));
  }
  return Effect.succeed(new Set(domains));
}

/** Splits a comma-separated env value into trimmed lowercase items. */
function csvItems(value: string | undefined): ReadonlyArray<string> {
  if (value == null || value === "") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}
