import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nonEmpty } from "../../../shared/src/util/strings";
import { isLoopbackHost } from "../../../shared/src/util/url";
import { normalizeAccessGroup, type AccessGroup } from "./access";

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
  /** How new projects map onto public route paths. */
  readonly projectRoutingMode: ProjectRoutingMode;
  /** Workspace assigned when a publish does not name one. */
  readonly defaultWorkspace: DefaultWorkspaceMode;
  /** Whether a publish may name a workspace that does not exist yet. The user's own
   * username workspace and server-assigned default workspaces are always allowed. */
  readonly usersCanCreateWorkspaces: boolean;
  /** Visibility applied when a publish does not specify one. */
  readonly defaultVisibility: AccessGroup;
  readonly auth: AuthConfig;
}

/** How published projects map onto public route paths. Routing is deterministic: every
 * route has exactly routeDepth(mode) segments, so a request path resolves to at most one
 * route. userDomain is the domain of the owner's email address. */
export type ProjectRoutingMode = "workspace/project" | "userDomain/workspace/project";

/** Workspace assigned when a publish omits one: a random slug, or the user's email
 * local part (pete@example.com publishes to workspace "pete"). */
export type DefaultWorkspaceMode = "random" | "username";

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
      appUrl: yield* readPublicUrl(
        nonEmpty(env.SCRATCHWORK_APP_URL) ?? urlFromDomain(env.SCRATCHWORK_APP_DOMAIN),
        "SCRATCHWORK_APP_URL",
      ),
      contentUrl: yield* readPublicUrl(
        nonEmpty(env.SCRATCHWORK_CONTENT_URL) ?? urlFromDomain(env.SCRATCHWORK_CONTENT_DOMAIN),
        "SCRATCHWORK_CONTENT_URL",
      ),
      maxVisibility: yield* readAccessGroup(env.SCRATCHWORK_MAX_VISIBILITY, "public", "SCRATCHWORK_MAX_VISIBILITY"),
      shareAllowedDomains: domainSet(env.SCRATCHWORK_SHARE_ALLOWED_DOMAINS),
      projectRoutingMode: yield* readProjectRoutingMode(env.SCRATCHWORK_PROJECT_ROUTING_MODE),
      defaultWorkspace: yield* readDefaultWorkspace(env.SCRATCHWORK_DEFAULT_WORKSPACE),
      usersCanCreateWorkspaces: yield* readBoolean(env.SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES, true, "SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES"),
      defaultVisibility: yield* readAccessGroup(env.SCRATCHWORK_DEFAULT_VISIBILITY, "private", "SCRATCHWORK_DEFAULT_VISIBILITY"),
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
      return Effect.fail(new ServerConfigError({ message: `${name} must be an origin, such as https://example.com` }));
    }
    // Loopback (including *.localhost, which resolves locally on modern systems)
    // may use http so local runs get real hostname-per-role URLs.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return Effect.fail(new ServerConfigError({ message: `${name} must use https, except loopback http for local development` }));
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(new ServerConfigError({ message: `${name} must be a valid URL` }));
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

/** Parses the project routing mode, defaulting to workspace/project. */
function readProjectRoutingMode(value: string | undefined): Effect.Effect<ProjectRoutingMode, ServerConfigError> {
  const mode = value == null || value === "" ? "workspace/project" : value;
  if (mode === "workspace/project" || mode === "userDomain/workspace/project") {
    return Effect.succeed(mode);
  }
  return Effect.fail(
    new ServerConfigError({
      message: "SCRATCHWORK_PROJECT_ROUTING_MODE must be workspace/project or userDomain/workspace/project",
    }),
  );
}

/** Parses the default-workspace mode, defaulting to the user's email local part. */
function readDefaultWorkspace(value: string | undefined): Effect.Effect<DefaultWorkspaceMode, ServerConfigError> {
  const mode = value == null || value === "" ? "username" : value;
  if (mode === "username" || mode === "random") {
    return Effect.succeed(mode);
  }
  return Effect.fail(
    new ServerConfigError({ message: "SCRATCHWORK_DEFAULT_WORKSPACE must be username or random" }),
  );
}

/** Parses one boolean environment value with a fallback. */
function readBoolean(value: string | undefined, fallback: boolean, name: string): Effect.Effect<boolean, ServerConfigError> {
  if (value == null || value === "") return Effect.succeed(fallback);
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return Effect.succeed(true);
  if (normalized === "false") return Effect.succeed(false);
  return Effect.fail(new ServerConfigError({ message: `${name} must be true or false` }));
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

/** Splits a comma-separated env value into trimmed lowercase items. */
function csvItems(value: string | undefined): ReadonlyArray<string> {
  if (value == null || value === "") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}
