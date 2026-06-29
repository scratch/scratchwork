#!/usr/bin/env bun
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BunRuntime } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "./app";
import { ServerConfig, ServerConfigLive, type StorageConfig } from "./config";
import { ObjectStorageLive } from "./storage";

const BaseLayer = Layer.mergeAll(
  BunHttpServer.layerContext,
  BunFileSystem.layer,
  BunPath.layer,
  ServerConfigLive,
);

const MainLayer = Layer.provideMerge(ObjectStorageLive, BaseLayer);

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const server = yield* BunHttpServer.make({ port: config.port, idleTimeout: 60 });
    yield* server.serve(app);
    yield* Console.log(
      [
        "scratchwork server",
        `listening  http://localhost:${config.port}`,
        `storage    ${storageLabel(config.storage)}`,
      ].join("\n"),
    );
    return yield* Effect.never;
  }),
);

program.pipe(Effect.provide(MainLayer), BunRuntime.runMain);

function storageLabel(storage: StorageConfig): string {
  return storage._tag === "Local" ? `local:${storage.directory}` : `s3:${storage.bucket}`;
}
