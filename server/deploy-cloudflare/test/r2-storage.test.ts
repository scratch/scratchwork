import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { ObjectStorage } from "@scratchwork/server-core/storage";
import { R2ObjectStorageLive, type R2BucketBinding } from "../src/r2-storage";

describe("R2ObjectStorageLive", () => {
  test("uses raw R2 etags for conditional writes", async () => {
    const bucket = fakeBucket();
    const storage = await Effect.runPromise(Effect.gen(function* () {
      return yield* ObjectStorage;
    }).pipe(Effect.provide(R2ObjectStorageLive(bucket))));

    const first = await Effect.runPromise(storage.putText("sites/a/site.v2.json", "one", { ifNoneMatch: "*" }));
    expect(first.etag).toBe("etag-1");
    await expect(Effect.runPromise(storage.putText("sites/a/site.v2.json", "two", { ifNoneMatch: "*" }))).rejects.toThrow("already exists");

    const loaded = await Effect.runPromise(storage.getObject("sites/a/site.v2.json"));
    expect(loaded?.etag).toBe("etag-1");
    expect(loaded?.etag).not.toBe('"etag-1"');

    const second = await Effect.runPromise(storage.putText("sites/a/site.v2.json", "two", { ifMatch: loaded?.etag }));
    expect(second.etag).toBe("etag-2");
    await expect(Effect.runPromise(storage.putText("sites/a/site.v2.json", "three", { ifMatch: "etag-1" }))).rejects.toThrow("mismatch");
  });
});

/** Provides a small R2 fake with raw and quoted ETag behavior. */
function fakeBucket(): R2BucketBinding {
  const objects = new Map<string, { body: Uint8Array; etag: string; contentType?: string }>();
  let version = 0;
  return {
    get: async (key) => {
      const object = objects.get(key);
      if (object == null) return null;
      return {
        etag: object.etag,
        httpEtag: `"${object.etag}"`,
        httpMetadata: { contentType: object.contentType },
        arrayBuffer: async () => object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength) as ArrayBuffer,
        text: async () => new TextDecoder().decode(object.body),
      };
    },
    put: async (key, value, options) => {
      const existing = objects.get(key);
      if (options?.onlyIf?.etagMatches != null && existing?.etag !== options.onlyIf.etagMatches) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && existing != null) return null;
      const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const etag = `etag-${++version}`;
      objects.set(key, { body, etag, contentType: options?.httpMetadata?.contentType });
      return { etag, httpEtag: `"${etag}"` };
    },
  };
}
