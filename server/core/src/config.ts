import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type EnvVars = Readonly<Record<string, string | undefined>>;

export interface ServerConfigShape {
  readonly port: number;
  readonly publicUrl?: string;
  readonly auth: AuthConfig;
}

export type AuthConfig =
  | {
      readonly _tag: "Disabled";
    }
  | {
      readonly _tag: "Google";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly sessionSecret: string;
      readonly allowedEmails: ReadonlySet<string>;
      readonly allowedDomains: ReadonlySet<string>;
      readonly sessionTtlSeconds: number;
    };

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

/** Parses disabled or Google auth settings from environment variables. */
function readAuthConfig(env: EnvVars): Effect.Effect<AuthConfig, ServerConfigError> {
  const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
  const clientId = env.SCRATCHWORK_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = env.SCRATCHWORK_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.SCRATCHWORK_SESSION_SECRET;
  const wantsGoogle = authMode === "google" || clientId != null || clientSecret != null || sessionSecret != null;

  if (!wantsGoogle) return Effect.succeed({ _tag: "Disabled" });
  if (authMode !== "" && authMode !== "google") {
    return Effect.fail(new ServerConfigError({ message: "SCRATCHWORK_AUTH must be \"google\" when set" }));
  }
  if (!clientId || !clientSecret || !sessionSecret) {
    return Effect.fail(
      new ServerConfigError({
        message: "Google auth requires SCRATCHWORK_GOOGLE_CLIENT_ID, SCRATCHWORK_GOOGLE_CLIENT_SECRET, and SCRATCHWORK_SESSION_SECRET",
      }),
    );
  }
  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    return Effect.fail(
      new ServerConfigError({
        message: "SCRATCHWORK_SESSION_SECRET must be at least 32 bytes",
      }),
    );
  }

  return Effect.succeed({
    _tag: "Google",
    clientId,
    clientSecret,
    sessionSecret,
    allowedEmails: csvSet(env.SCRATCHWORK_AUTH_ALLOWED_EMAILS),
    allowedDomains: csvSet(env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS),
    sessionTtlSeconds: parsePositiveInteger(env.SCRATCHWORK_AUTH_SESSION_SECONDS) ?? 60 * 60 * 24 * 30,
  });
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
function csvSet(value: string | undefined): ReadonlySet<string> {
  if (value == null || value === "") return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}
