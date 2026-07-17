/*
 * Runs the invariant-6 conformance suites against the in-memory reference
 * implementations. The same suites run unchanged against D1/R2 (miniflare)
 * and DynamoDB/S3 (LocalStack) in e2e/test/adapter-conformance-*.test.ts,
 * and against the local file storage in server/deploy-local.
 */
import { makeMemoryPrimitiveDb } from "../src/db";
import { runPrimitiveDbConformance } from "./conformance/primitive-db";
import { runObjectStorageConformance } from "./conformance/object-storage";
import { memoryStorage } from "./helpers";

runPrimitiveDbConformance({
  name: "memory",
  makeDb: async () => makeMemoryPrimitiveDb(),
});

runObjectStorageConformance({
  name: "memory",
  makeStorage: async () => memoryStorage(new Map()),
});
