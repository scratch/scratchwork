import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nonEmpty } from "../../../shared/src/util/strings";
import { isLoopbackHost } from "../../../shared/src/util/url";
import { isReservedSlug, isSafeProjectIdentifier, normalizeAccessGroup, safeDomain, type AccessGroup } from "./access";

/** An environment-variable map from any platform (process.env, Worker vars, Lambda env). */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/** Parsed server configuration. */
export interface ServerConfigShape {
  readonly port: number;
  /** Public origin of the app host (auth routes and API), when configured. */
  readonly appUrl?: string;
  /** Public origin of the content host (published sites), when configured. */
  readonly contentUrl?: string;
  /** Origins served from the homepage project (first is canonical, the rest 308 to it).
   * Empty when the server has no homepage. */
  readonly homepageUrls: ReadonlyArray<string>;
  /** Name of the project served on the homepage origins; set iff homepageUrls is non-empty. */
  readonly homepageProject?: string;
  /** false: no project may be public — existing public projects read as private. */
  readonly allowPublicProjects: boolean;
  /** When non-empty, share grants must fall inside these domains; grants outside them
   * stop conferring access. */
  readonly allowedShareDomains: ReadonlySet<string>;
  /** true: publishers choose globally-unique project names (first-writer-wins).
   * false: the server assigns a random slug on first publish. */
  readonly usersCanSetProjectNames: boolean;
  readonly auth: AuthConfig;
}

/** Session-signing and allow-list settings shared by every auth mode. */
export interface AuthConfigCommon {
  readonly sessionSecret: string;
  readonly allowedUsers: AccessGroup;
  readonly sessionTtlSeconds: number;
}

/** Authorization-server endpoints used by the OAuth login flow. Overridable only
 * by the loopback-gated local test configuration; production always uses Google's. */
export interface OAuthProviderEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
}

/** Built-in Google OAuth: the server runs the login flow itself. */
export interface OAuthAuthConfig extends AuthConfigCommon {
  readonly mode: "oauth";
  readonly clientId: string;
  readonly clientSecret: string;
  /** Provider endpoints supplied only by the hermetic local test provider. */
  readonly localEndpoints?: OAuthProviderEndpoints;
}

/** Cloudflare Access: the server sits behind an Access application that authenticates
 * users at the edge and injects a signed Cf-Access-Jwt-Assertion header. */
export interface CloudflareAccessAuthConfig extends AuthConfigCommon {
  /** Team origin the assertions are issued by, like "https://myteam.cloudflareaccess.com". */
  readonly teamDomain: string;
  /** Audience (AUD) tag of the Access application protecting this server. */
  readonly audience: string;
  /** Public signing keys supplied only by the offline local Access simulator. */
  readonly localJwks?: ReadonlyArray<JsonWebKey & { readonly kid?: string }>;
  readonly mode: "cloudflare-access";
}

/** Auth settings. Auth cannot be disabled. */
export type AuthConfig = OAuthAuthConfig | CloudflareAccessAuthConfig;

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

    const appUrl = yield* readPublicUrl(
      nonEmpty(env.SCRATCHWORK_APP_URL) ?? urlFromDomain(env.SCRATCHWORK_APP_DOMAIN),
      "SCRATCHWORK_APP_URL",
    );
    const contentUrl = yield* readPublicUrl(
      nonEmpty(env.SCRATCHWORK_CONTENT_URL) ?? urlFromDomain(env.SCRATCHWORK_CONTENT_DOMAIN),
      "SCRATCHWORK_CONTENT_URL",
    );

    yield* rejectRetiredEnvVars(env);
    return {
      port,
      appUrl,
      contentUrl,
      ...(yield* readHomepage(env, appUrl, contentUrl)),
      allowPublicProjects: yield* readBoolean(env.SCRATCHWORK_ALLOW_PUBLIC_PROJECTS, true, "SCRATCHWORK_ALLOW_PUBLIC_PROJECTS"),
      allowedShareDomains: yield* readDomainSet(env.SCRATCHWORK_ALLOWED_SHARE_DOMAINS, "SCRATCHWORK_ALLOWED_SHARE_DOMAINS"),
      usersCanSetProjectNames: yield* readBoolean(env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES, true, "SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES"),
      auth: yield* readAuthConfig(env, appUrl),
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

/** Parses the optional server-homepage settings: the origins served from the homepage
 * project (bare domains or full origins, comma-separated; the first is canonical) and
 * the project's name. Set both or neither. The homepage origins must be distinct from
 * the app and content origins, since the hostname decides the routing model. */
function readHomepage(
  env: EnvVars,
  appUrl: string | undefined,
  contentUrl: string | undefined,
): Effect.Effect<Pick<ServerConfigShape, "homepageUrls" | "homepageProject">, ServerConfigError> {
  return Effect.gen(function* () {
    const domains = nonEmpty(env.SCRATCHWORK_HOMEPAGE_DOMAINS?.trim());
    const project = nonEmpty(env.SCRATCHWORK_HOMEPAGE_PROJECT?.trim());
    if (domains == null && project == null) return { homepageUrls: [] };
    if (domains == null || project == null) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "SCRATCHWORK_HOMEPAGE_DOMAINS and SCRATCHWORK_HOMEPAGE_PROJECT must be set together: the domains say where the homepage is served, the project says which project it is",
        }),
      );
    }
    if (!isSafeProjectIdentifier(project) || isReservedSlug(project)) {
      return yield* Effect.fail(invalidValue("SCRATCHWORK_HOMEPAGE_PROJECT", project, 'a publishable project name, like "home"'));
    }

    const homepageUrls: Array<string> = [];
    for (const item of csvItems(domains)) {
      const url = yield* readPublicUrl(urlFromDomain(item), "SCRATCHWORK_HOMEPAGE_DOMAINS");
      if (url == null || homepageUrls.includes(url)) continue;
      if (url === appUrl || url === contentUrl) {
        return yield* Effect.fail(
          invalidValue("SCRATCHWORK_HOMEPAGE_DOMAINS", item, "a homepage origin distinct from the app and content origins, which use path-based routing"),
        );
      }
      homepageUrls.push(url);
    }
    if (homepageUrls.length === 0) {
      return yield* Effect.fail(
        invalidValue("SCRATCHWORK_HOMEPAGE_DOMAINS", domains, 'a comma-separated list of domains or origins, like "example.com,www.example.com"'),
      );
    }
    return { homepageUrls, homepageProject: project };
  });
}

/** Parses auth settings from environment variables. Auth cannot be disabled, and the
 * mode must be chosen explicitly: a server either runs built-in Google OAuth or sits
 * behind Cloudflare Access. */
function readAuthConfig(env: EnvVars, appUrl: string | undefined): Effect.Effect<AuthConfig, ServerConfigError> {
  return Effect.gen(function* () {
    const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
    if (authMode === "") {
      return yield* Effect.fail(
        new ServerConfigError({
          message: 'SCRATCHWORK_AUTH is required: set it to "oauth" or "cloudflare-access".',
        }),
      );
    }
    if (authMode !== "oauth" && authMode !== "cloudflare-access") {
      return yield* Effect.fail(invalidValue("SCRATCHWORK_AUTH", authMode, '"oauth" or "cloudflare-access"'));
    }
    if (authMode === "cloudflare-access") return yield* readCloudflareAccessConfig(env, appUrl);
    return yield* readOAuthConfig(env, appUrl);
  });
}

/** Parses required Google OAuth settings from environment variables. */
function readOAuthConfig(env: EnvVars, appUrl: string | undefined): Effect.Effect<OAuthAuthConfig, ServerConfigError> {
  return Effect.gen(function* () {
    const clientId = env.SCRATCHWORK_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
    const clientSecret = env.SCRATCHWORK_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
    const sessionSecret = env.SCRATCHWORK_SESSION_SECRET;

    if (!clientId || !clientSecret || !sessionSecret) {
      const missing = [
        clientId ? null : "SCRATCHWORK_GOOGLE_CLIENT_ID",
        clientSecret ? null : "SCRATCHWORK_GOOGLE_CLIENT_SECRET",
        sessionSecret ? null : "SCRATCHWORK_SESSION_SECRET",
      ].filter((name) => name != null);
      return yield* Effect.fail(
        new ServerConfigError({
          message: `OAuth mode requires ${missing.join(", ")}: create OAuth credentials at https://console.cloud.google.com/apis/credentials and generate a session secret with "openssl rand -hex 32".`,
        }),
      );
    }

    return {
      mode: "oauth",
      clientId,
      clientSecret,
      ...(yield* readLocalOAuthEndpoints(env, appUrl)),
      ...(yield* readCommonAuthConfig(env, sessionSecret)),
    } as const;
  });
}

/** Parses the hermetic test provider's endpoints. Like the local Cloudflare JWKS
 * override, the LOCAL prefix and the loopback gates keep this out of production
 * configuration: the variables are accepted only when the app origin is loopback,
 * and every endpoint must itself be a loopback URL. Set all three or none. */
function readLocalOAuthEndpoints(
  env: EnvVars,
  appUrl: string | undefined,
): Effect.Effect<Pick<OAuthAuthConfig, "localEndpoints">, ServerConfigError> {
  const names = [
    "SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL",
    "SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL",
    "SCRATCHWORK_LOCAL_OAUTH_JWKS_URL",
  ] as const;
  const values = names.map((name) => nonEmpty(env[name]));
  if (values.every((value) => value == null)) return Effect.succeed({});
  if (appUrl == null || !isLoopbackHost(new URL(appUrl).hostname)) {
    return Effect.fail(
      new ServerConfigError({
        message: "SCRATCHWORK_LOCAL_OAUTH_* endpoints are accepted only when SCRATCHWORK_APP_URL uses a loopback host",
      }),
    );
  }
  if (values.some((value) => value == null)) {
    return Effect.fail(
      new ServerConfigError({ message: `Set all of ${names.join(", ")} or none of them` }),
    );
  }
  for (const [index, value] of values.entries()) {
    if (!isLoopbackUrl(value as string)) {
      return Effect.fail(invalidValue(names[index], value as string, 'a loopback URL, like "http://127.0.0.1:4300/authorize"'));
    }
  }
  const [authorizeUrl, tokenUrl, jwksUrl] = values as [string, string, string];
  return Effect.succeed({ localEndpoints: { authorizeUrl, tokenUrl, jwksUrl } });
}

/** Returns true for an http(s) URL whose host is loopback. */
function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Parses required Cloudflare Access settings from environment variables. */
function readCloudflareAccessConfig(env: EnvVars, appUrl: string | undefined): Effect.Effect<CloudflareAccessAuthConfig, ServerConfigError> {
  return Effect.gen(function* () {
    const teamDomainValue = nonEmpty(env.SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN?.trim());
    const audience = nonEmpty(env.SCRATCHWORK_CF_ACCESS_AUD?.trim());
    const sessionSecret = env.SCRATCHWORK_SESSION_SECRET;

    if (teamDomainValue == null || audience == null || !sessionSecret) {
      const missing = [
        teamDomainValue != null ? null : "SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN",
        audience != null ? null : "SCRATCHWORK_CF_ACCESS_AUD",
        sessionSecret ? null : "SCRATCHWORK_SESSION_SECRET",
      ].filter((name) => name != null);
      return yield* Effect.fail(
        new ServerConfigError({
          message: `Cloudflare Access mode requires ${missing.join(", ")}: copy the team domain and the application Audience (AUD) tag from the Cloudflare Zero Trust dashboard, and generate a session secret with "openssl rand -hex 32".`,
        }),
      );
    }

    const teamDomain = normalizeCfTeamDomain(teamDomainValue);
    if (teamDomain == null) {
      return yield* Effect.fail(
        invalidValue("SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN", teamDomainValue, 'a Cloudflare Access team domain, like "myteam" or "myteam.cloudflareaccess.com"'),
      );
    }

    return {
      mode: "cloudflare-access",
      teamDomain,
      audience,
      ...(yield* readLocalCloudflareJwks(env.SCRATCHWORK_LOCAL_CF_ACCESS_JWKS, appUrl)),
      ...(yield* readCommonAuthConfig(env, sessionSecret)),
    } as const;
  });
}

/** Parses the generated public JWKS used by the offline Access simulator. Keeping the
 * override behind a LOCAL-prefixed variable prevents it from becoming part of normal
 * Cloudflare deployment configuration. */
function readLocalCloudflareJwks(
  value: string | undefined,
  appUrl: string | undefined,
): Effect.Effect<Pick<CloudflareAccessAuthConfig, "localJwks">, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed({});
  if (appUrl == null || !isLoopbackHost(new URL(appUrl).hostname)) {
    return Effect.fail(
      new ServerConfigError({
        message: "SCRATCHWORK_LOCAL_CF_ACCESS_JWKS is accepted only when SCRATCHWORK_APP_URL uses a loopback host",
      }),
    );
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed == null || !Array.isArray((parsed as { readonly keys?: unknown }).keys)) {
      throw new Error("keys is not an array");
    }
    const keys = (parsed as { readonly keys: ReadonlyArray<unknown> }).keys;
    if (keys.length === 0 || keys.some((key) => typeof key !== "object" || key == null)) {
      throw new Error("keys is empty or invalid");
    }
    return Effect.succeed({ localJwks: keys as ReadonlyArray<JsonWebKey & { readonly kid?: string }> });
  } catch {
    return Effect.fail(
      invalidValue("SCRATCHWORK_LOCAL_CF_ACCESS_JWKS", value, "a generated JWKS JSON document with at least one public key"),
    );
  }
}

/** Parses the auth settings every mode shares: the session-signing secret (validated
 * for length), the allow-list, and the session lifetime. */
function readCommonAuthConfig(env: EnvVars, sessionSecret: string): Effect.Effect<AuthConfigCommon, ServerConfigError> {
  return Effect.gen(function* () {
    if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: 'SCRATCHWORK_SESSION_SECRET must be at least 32 bytes: generate one with "openssl rand -hex 32"',
        }),
      );
    }
    return {
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

/** Normalizes the configured Cloudflare Access team domain — "myteam",
 * "myteam.cloudflareaccess.com", or a full https URL — to its https origin. */
function normalizeCfTeamDomain(value: string): string | null {
  const host = value
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/[/?#].*$/, "");
  const domain = host.includes(".") ? host : `${host}.cloudflareaccess.com`;
  return safeDomain(domain) ? `https://${domain}` : null;
}

/** Retired variables and their replacements. These carried access policy, so silently
 * ignoring one could leave a server more open than its operator intended — refuse to
 * start instead. */
const RETIRED_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["SCRATCHWORK_SHARE_ALLOWED_DOMAINS", "SCRATCHWORK_ALLOWED_SHARE_DOMAINS"],
];

/** Fails when a retired environment variable is still set. */
function rejectRetiredEnvVars(env: EnvVars): Effect.Effect<void, ServerConfigError> {
  for (const [name, replacement] of RETIRED_ENV_VARS) {
    if (nonEmpty(env[name]) != null) {
      return Effect.fail(new ServerConfigError({ message: `${name} is no longer supported: use ${replacement} instead` }));
    }
  }
  return Effect.void;
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
