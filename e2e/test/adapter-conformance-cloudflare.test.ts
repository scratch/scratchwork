/*
 * Runs the invariant-6 conformance suites against the Cloudflare adapters —
 * D1PrimitiveDb and R2ObjectStorage — under miniflare/workerd bindings, the
 * same simulation the cloudflare publish-loop lane uses. No HTTP server is
 * involved: the bindings are exercised directly through the adapters.
 */
import { afterAll } from "bun:test";
import * as Effect from "effect/Effect";
import { Miniflare } from "miniflare";
import { PrimitiveDb } from "@scratchwork/server-core/db";
import { D1PrimitiveDbLive, type D1DatabaseBinding } from "@scratchwork/server-deploy-cloudflare/d1-db";
import { R2ObjectStorageLive, type R2BucketBinding } from "@scratchwork/server-deploy-cloudflare/r2-storage";
import { ObjectStorage } from "@scratchwork/server-core/storage";
import { runPrimitiveDbConformance } from "../../server/core/test/conformance/primitive-db";
import { runObjectStorageConformance } from "../../server/core/test/conformance/object-storage";

let miniflare: Miniflare | null = null;

/** One miniflare instance shared by both suites; created at first use. */
async function ensureMiniflare(): Promise<Miniflare> {
  if (miniflare == null) {
    miniflare = new Miniflare({
      modules: true,
      // The worker script is never fetched; miniflare just hosts the bindings.
      script: "export default { fetch() { return new Response(null, { status: 404 }); } }",
      r2Buckets: ["CONFORMANCE_BUCKET"],
      d1Databases: ["CONFORMANCE_DB"],
    });
    await miniflare.ready;
  }
  return miniflare;
}

afterAll(async () => {
  await miniflare?.dispose();
});

runPrimitiveDbConformance({
  name: "d1 (miniflare)",
  makeDb: async () => {
    const mf = await ensureMiniflare();
    const database = (await mf.getD1Database("CONFORMANCE_DB")) as unknown as D1DatabaseBinding;
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* PrimitiveDb;
      }).pipe(Effect.provide(D1PrimitiveDbLive(database))),
    );
  },
});

runObjectStorageConformance({
  name: "r2 (miniflare)",
  makeStorage: async () => {
    const mf = await ensureMiniflare();
    const bucket = (await mf.getR2Bucket("CONFORMANCE_BUCKET")) as unknown as R2BucketBinding;
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* ObjectStorage;
      }).pipe(Effect.provide(R2ObjectStorageLive(bucket))),
    );
  },
});
