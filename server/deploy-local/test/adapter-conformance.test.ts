/*
 * Runs the invariant-6 ObjectStorage conformance suite against the local
 * filesystem backend this deploy target serves from. Content types are not
 * preserved by design: the file backend stores bare bytes and the site server
 * re-derives types from extensions.
 */
import { afterAll } from "bun:test";
import { BunContext } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import { ObjectStorage, LocalObjectStorageLive } from "@scratchwork/server-core/storage";
import { runObjectStorageConformance } from "../../core/test/conformance/object-storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "scratchwork-storage-conformance-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

runObjectStorageConformance({
  name: "local-file",
  preservesContentType: false,
  makeStorage: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* ObjectStorage;
      }).pipe(
        Effect.provide(LocalObjectStorageLive(directory)),
        Effect.provide(BunContext.layer),
      ),
    ),
});
