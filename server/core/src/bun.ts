#!/usr/bin/env bun
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BunRuntime } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "./app";
import { AuthLive } from "./auth";
import { ServerConfig, ServerConfigLive } from "./config";
import { LocalObjectStorageLive } from "./storage";

const storageDirectory = process.env.SCRATCHWORK_STORAGE_DIR ?? ".scratchwork-data";

const BaseLayer = Layer.mergeAll(
  BunHttpServer.layerContext,
  BunFileSystem.layer,
  BunPath.layer,
  ServerConfigLive,
);

const MainLayer = Layer.provideMerge(
  Layer.mergeAll(LocalObjectStorageLive(storageDirectory), AuthLive),
  BaseLayer,
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const server = yield* BunHttpServer.make({ port: config.port, idleTimeout: 60 });
    yield* server.serve(app);
    yield* Console.log(
      [
        "scratchwork server",
        `listening  http://localhost:${config.port}`,
        `storage    local:${storageDirectory}`,
      ].join("\n"),
    );
    return yield* Effect.never;
  }),
);

program.pipe(Effect.provide(MainLayer), BunRuntime.runMain);
