/*
 * The ObjectStorage conformance suite (AGENTS.md, invariant 6): one set of
 * behavioral tests every blob backend — in-memory, local file, R2, S3 — must
 * pass unchanged: round trips, ETag-conditional writes, key validation,
 * concurrency, and error mapping.
 *
 * Two declared capability differences, parameterized rather than pinned:
 *  - `preservesContentType`: the local file backend stores bare bytes and
 *    re-derives content types from extensions at serve time; provider
 *    backends persist the metadata.
 *  - ifMatch against a MISSING key must fail, but backends disagree on the
 *    flavor (a conflict vs. a provider not-found error); the suite requires
 *    failure without pinning the tag.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { ObjectStorageShape, StorageConflict, StorageError } from "../../src/storage";

/** One backend under conformance test. */
export interface ObjectStorageConformanceOptions {
  /** Backend label shown in test names. */
  readonly name: string;
  /** Supplies the backend; called once, lazily, at the first test. */
  readonly makeStorage: () => Promise<ObjectStorageShape>;
  /** Whether get() reports the contentType given to put(). Default true. */
  readonly preservesContentType?: boolean;
  /** Per-test timeout for emulator-backed runs. */
  readonly timeout?: number;
}

type StorageFailure = StorageError | StorageConflict;

/** Registers the conformance suite for one backend. */
export function runObjectStorageConformance(options: ObjectStorageConformanceOptions): void {
  const timeout = options.timeout ?? 20_000;
  let cached: Promise<ObjectStorageShape> | null = null;
  const storage = () => (cached ??= options.makeStorage());

  // Keys are per-test so tests are order-independent on a shared bucket.
  const base = `conf/${crypto.randomUUID().slice(0, 12)}`;
  let counter = 0;
  const key = (suffix = "object") => `${base}/${++counter}/${suffix}`;

  const run = async <A>(effect: Effect.Effect<A, StorageFailure>): Promise<A> => Effect.runPromise(effect);
  const attempt = async <A>(effect: Effect.Effect<A, StorageFailure>): Promise<Either.Either<A, StorageFailure>> =>
    Effect.runPromise(Effect.either(effect));

  const expectConflict = (result: Either.Either<unknown, StorageFailure>, expectedKey: string) => {
    if (!Either.isLeft(result)) throw new Error(`expected StorageConflict, got success`);
    expect(result.left._tag).toBe("StorageConflict");
    expect((result.left as StorageConflict).key).toBe(expectedKey);
  };
  const expectFailure = (result: Either.Either<unknown, StorageFailure>) => {
    if (!Either.isLeft(result)) throw new Error("expected a failure, got success");
    expect(["StorageConflict", "StorageError"]).toContain(result.left._tag);
  };
  const expectError = (result: Either.Either<unknown, StorageFailure>) => {
    if (!Either.isLeft(result)) throw new Error("expected StorageError, got success");
    expect(result.left._tag).toBe("StorageError");
  };

  describe(`ObjectStorage conformance [${options.name}]`, () => {
    test("a missing key reads as null", async () => {
      const s = await storage();
      expect(await run(s.getObject(key("missing")))).toBeNull();
    }, timeout);

    test("binary bodies round-trip byte-for-byte, including empty and all byte values", async () => {
      const s = await storage();
      const everyByte = Uint8Array.from({ length: 256 * 32 }, (_, index) => index % 256);
      for (const body of [everyByte, new Uint8Array(0), Uint8Array.from([0, 255, 10, 13, 0])]) {
        const k = key("bin");
        await run(s.putObject(k, body));
        const got = await run(s.getObject(k));
        expect(got?.key).toBe(k);
        expect(got == null ? null : Array.from(got.body)).toEqual(Array.from(body));
      }
    }, timeout);

    test("putText stores UTF-8 exactly", async () => {
      const s = await storage();
      const k = key("text.txt");
      const text = "héllo → wörld 🎉\nline two";
      await run(s.putText(k, text));
      const got = await run(s.getObject(k));
      expect(new TextDecoder().decode(got?.body)).toBe(text);
    }, timeout);

    test("content types are preserved (when the backend stores metadata)", async () => {
      const s = await storage();
      const k = key("page.html");
      await run(s.putText(k, "<!doctype html>", { contentType: "text/html; charset=utf-8" }));
      const got = await run(s.getObject(k));
      if (options.preservesContentType !== false) {
        expect(got?.contentType).toBe("text/html; charset=utf-8");
      }
    }, timeout);

    test("ETags are stable across put/get and change when content changes", async () => {
      const s = await storage();
      const k = key("etag");
      const first = await run(s.putText(k, "generation one"));
      expect(first.etag).toBeDefined();
      const got = await run(s.getObject(k));
      expect(got?.etag).toBe(first.etag);
      const second = await run(s.putText(k, "generation two"));
      expect(second.etag).toBeDefined();
      expect(second.etag).not.toBe(first.etag);
      expect((await run(s.getObject(k)))?.etag).toBe(second.etag);
    }, timeout);

    test("conditional create succeeds once and never clobbers the winner", async () => {
      const s = await storage();
      const k = key("create");
      await run(s.putText(k, "first", { ifNoneMatch: "*" }));
      expectConflict(await attempt(s.putText(k, "second", { ifNoneMatch: "*" })), k);
      expect(new TextDecoder().decode((await run(s.getObject(k)))?.body)).toBe("first");
    }, timeout);

    test("conditional update honors the current ETag and rejects stale ones", async () => {
      const s = await storage();
      const k = key("update");
      const first = await run(s.putText(k, "v1"));
      const updated = await run(s.putText(k, "v2", { ifMatch: first.etag }));
      expect(updated.etag).not.toBe(first.etag);
      expectConflict(await attempt(s.putText(k, "v3", { ifMatch: first.etag })), k);
      expect(new TextDecoder().decode((await run(s.getObject(k)))?.body)).toBe("v2");
    }, timeout);

    test("conditional update of a missing key fails", async () => {
      const s = await storage();
      expectFailure(await attempt(s.putText(key("absent"), "v", { ifMatch: "some-etag" })));
    }, timeout);

    test("unsafe keys are rejected for reads and writes alike", async () => {
      const s = await storage();
      for (const bad of ["", "/absolute", "a//b", "dot/./seg", "../up", "up/..", "back\\slash", "nul\0", "x".repeat(1025)]) {
        expectError(await attempt(s.getObject(bad)));
        expectError(await attempt(s.putText(bad, "v")));
      }
    }, timeout);

    test("concurrent conditional creates admit exactly one winner", async () => {
      const s = await storage();
      const k = key("race");
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) => attempt(s.putText(k, `writer-${index}`, { ifNoneMatch: "*" }))),
      );
      const winners = results.filter(Either.isRight);
      expect(winners).toHaveLength(1);
      for (const loser of results.filter(Either.isLeft)) {
        expect(loser.left._tag).toBe("StorageConflict");
      }
    }, timeout);
  });
}
