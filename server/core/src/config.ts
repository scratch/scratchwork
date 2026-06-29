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

export function makeServerConfigLayer(
  env: EnvVars,
): Layer.Layer<ServerConfig, ServerConfigError> {
  return Layer.effect(ServerConfig, readServerConfig(env));
}

export const ServerConfigLive: Layer.Layer<ServerConfig, ServerConfigError> =
  makeServerConfigLayer(readProcessEnv());

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
      publicUrl: trimTrailingSlash(env.SCRATCHWORK_PUBLIC_URL),
      auth: yield* readAuthConfig(env),
    };
  });
}

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

function readProcessEnv(): EnvVars {
  const processLike = globalThis as typeof globalThis & {
    readonly process?: { readonly env?: EnvVars };
  };
  return processLike.process?.env ?? {};
}

function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  if (value == null || value === "") return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return value.replace(/\/+$/, "");
}
