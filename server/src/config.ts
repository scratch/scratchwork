import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type StorageConfig =
  | {
      readonly _tag: "Local";
      readonly directory: string;
    }
  | {
      readonly _tag: "S3";
      readonly bucket: string;
      readonly region: string;
      readonly endpoint?: string;
      readonly forcePathStyle: boolean;
    };

export interface ServerConfigShape {
  readonly port: number;
  readonly publicUrl?: string;
  readonly storage: StorageConfig;
}

export class ServerConfig extends Context.Tag("@scratchwork/server/Config")<
  ServerConfig,
  ServerConfigShape
>() {}

export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string;
}> {}

export const ServerConfigLive: Layer.Layer<ServerConfig, ServerConfigError> =
  Layer.effect(ServerConfig, readServerConfig());

function readServerConfig(): Effect.Effect<ServerConfigShape, ServerConfigError> {
  return Effect.gen(function* () {
    const env = process.env;
    const port = parsePort(env.PORT ?? env.SCRATCHWORK_PORT ?? "3001");
    if (port == null) {
      return yield* Effect.fail(
        new ServerConfigError({
          message: "PORT must be an integer between 1 and 65535",
        }),
      );
    }

    const storageMode = (env.SCRATCHWORK_STORAGE ?? (env.SCRATCHWORK_S3_BUCKET || env.R2_BUCKET ? "s3" : "local")).toLowerCase();
    const storage = yield* storageConfig(storageMode, env);

    return {
      port,
      publicUrl: trimTrailingSlash(env.SCRATCHWORK_PUBLIC_URL),
      storage,
    };
  });
}

function storageConfig(
  storageMode: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<StorageConfig, ServerConfigError> {
  if (storageMode === "local") {
    return Effect.succeed({
      _tag: "Local",
      directory: env.SCRATCHWORK_STORAGE_DIR ?? ".scratchwork-data",
    });
  }

  if (storageMode === "s3" || storageMode === "r2") {
    const bucket = env.SCRATCHWORK_S3_BUCKET ?? env.R2_BUCKET;
    if (!bucket) {
      return Effect.fail(
        new ServerConfigError({
          message: "SCRATCHWORK_S3_BUCKET or R2_BUCKET is required for S3/R2 storage",
        }),
      );
    }

    const r2Endpoint = env.R2_ACCOUNT_ID
      ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined;
    const endpoint = env.SCRATCHWORK_S3_ENDPOINT ?? env.R2_ENDPOINT ?? r2Endpoint;
    const region = env.SCRATCHWORK_S3_REGION ?? (storageMode === "r2" ? "auto" : "us-east-1");

    return Effect.succeed({
      _tag: "S3",
      bucket,
      region,
      endpoint,
      forcePathStyle: parseBoolean(env.SCRATCHWORK_S3_FORCE_PATH_STYLE) ?? endpoint != null,
    });
  }

  return Effect.fail(
    new ServerConfigError({
      message: `SCRATCHWORK_STORAGE must be "local", "s3", or "r2"; got "${storageMode}"`,
    }),
  );
}

function parsePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value == null || value === "") return null;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return null;
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return value.replace(/\/+$/, "");
}
