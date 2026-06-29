import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type EnvVars = Readonly<Record<string, string | undefined>>;

export interface ServerConfigShape {
  readonly port: number;
  readonly publicUrl?: string;
}

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
    };
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

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return value.replace(/\/+$/, "");
}
