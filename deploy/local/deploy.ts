import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BunRuntime } from "@effect/platform-bun";
import {
  AuthLive,
  LocalObjectStorageLive,
  MemoryPrimitiveDbLive,
  ServerConfig,
  SiteStoreLive,
  app,
  makeServerConfigLayer,
  type EnvVars,
} from "@scratchwork/server-core";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const processEnv = readProcessEnv();
const localPort = processEnv.PORT ?? processEnv.SCRATCHWORK_PORT ?? "43118";
const env: EnvVars = {
  ...processEnv,
  SCRATCHWORK_APP_URL: processEnv.SCRATCHWORK_APP_URL ?? `http://localhost:${localPort}`,
  SCRATCHWORK_CONTENT_URL: processEnv.SCRATCHWORK_CONTENT_URL ?? `http://localhost:${localPort}`,
  SCRATCHWORK_DEFAULT_VISIBILITY: processEnv.SCRATCHWORK_DEFAULT_VISIBILITY ?? "public",
  SCRATCHWORK_PROJECT_PATH: processEnv.SCRATCHWORK_PROJECT_PATH ?? "workspace/project",
  PORT: localPort,
};

const storageDirectory = env.SCRATCHWORK_STORAGE_DIR ?? ".scratchwork-local-data";

const BaseLayer = Layer.mergeAll(
  BunHttpServer.layerContext,
  BunFileSystem.layer,
  BunPath.layer,
  makeServerConfigLayer(env),
);

const StorageLayer = Layer.provideMerge(
  LocalObjectStorageLive(storageDirectory),
  BaseLayer,
);

const MainLayer = Layer.provideMerge(
  Layer.mergeAll(AuthLive, SiteStoreLive),
  Layer.mergeAll(StorageLayer, MemoryPrimitiveDbLive()),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const server = yield* BunHttpServer.make({ port: config.port, idleTimeout: 60 });
    yield* server.serve(app);
    const appUrl = config.appUrl ?? `http://localhost:${config.port}`;
    const contentUrl = config.contentUrl ?? appUrl;
    yield* Console.log(
      [
        "scratchwork local deploy",
        `app      ${appUrl}`,
        `content  ${contentUrl}`,
        `storage  local:${storageDirectory}`,
      ].join("\n"),
    );
    return yield* Effect.never;
  }),
);

program.pipe(Effect.provide(MainLayer), BunRuntime.runMain);

function readProcessEnv(): EnvVars {
  return process.env as EnvVars;
}
