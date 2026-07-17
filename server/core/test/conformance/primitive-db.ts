/*
 * The PrimitiveDb conformance suite (AGENTS.md, invariant 6): one set of
 * behavioral tests every backend — in-memory, D1, DynamoDB — must pass
 * unchanged, so a deploy target cannot weaken conditional-write, versioning,
 * pagination, expiry, validation, or error-mapping guarantees through adapter
 * drift. Call runPrimitiveDbConformance from a workspace test file with a
 * factory for the backend under test; the factory runs lazily at the first
 * test so emulator startup failures surface as test failures.
 *
 * Deliberately unpinned: the version counter of an UNCONDITIONAL overwrite of
 * an expired-but-not-yet-purged record (DynamoDB's async TTL can resume the
 * old counter where memory/D1 restart at 1). Nothing in the server observes
 * that version; conditional creates over expired records ARE pinned to
 * restart at 1.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { JsonValue, PrimitiveDbConflict, PrimitiveDbError, PrimitiveDbShape } from "../../src/db";

/** One backend under conformance test. */
export interface PrimitiveDbConformanceOptions {
  /** Backend label shown in test names. */
  readonly name: string;
  /** Supplies the backend; called once, lazily, at the first test. */
  readonly makeDb: () => Promise<PrimitiveDbShape>;
  /** Per-test timeout for emulator-backed runs. */
  readonly timeout?: number;
}

type DbFailure = PrimitiveDbError | PrimitiveDbConflict;

/** Registers the conformance suite for one backend. */
export function runPrimitiveDbConformance(options: PrimitiveDbConformanceOptions): void {
  const timeout = options.timeout ?? 20_000;
  let cached: Promise<PrimitiveDbShape> | null = null;
  const db = () => (cached ??= options.makeDb());

  // Namespaces are per-test so tests are order-independent and a shared
  // emulator (one D1 table, one DynamoDB table) never leaks state across them.
  const base = `conf${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  let counter = 0;
  const namespace = () => `${base}.${++counter}`;

  const run = async <A>(effect: Effect.Effect<A, DbFailure>): Promise<A> => Effect.runPromise(effect);
  const attempt = async <A>(effect: Effect.Effect<A, DbFailure>): Promise<Either.Either<A, DbFailure>> =>
    Effect.runPromise(Effect.either(effect));

  const expectConflict = (result: Either.Either<unknown, DbFailure>, ns: string, key: string) => {
    if (!Either.isLeft(result)) throw new Error(`expected PrimitiveDbConflict, got success: ${JSON.stringify(result.right)}`);
    expect(result.left._tag).toBe("PrimitiveDbConflict");
    expect((result.left as PrimitiveDbConflict).namespace).toBe(ns);
    expect((result.left as PrimitiveDbConflict).key).toBe(key);
  };
  const expectError = (result: Either.Either<unknown, DbFailure>) => {
    if (!Either.isLeft(result)) throw new Error(`expected PrimitiveDbError, got success: ${JSON.stringify(result.right)}`);
    expect(result.left._tag).toBe("PrimitiveDbError");
  };

  describe(`PrimitiveDb conformance [${options.name}]`, () => {
    test("a missing key reads as null and deletes as a no-op", async () => {
      const ns = namespace();
      expect(await run(Effect.flatMap(Effect.promise(db), (d) => d.get(ns, "missing")))).toBeNull();
      await run(Effect.flatMap(Effect.promise(db), (d) => d.delete(ns, "missing")));
    }, timeout);

    test("JSON values round-trip exactly, with version 1 and an ISO timestamp", async () => {
      const d = await db();
      const ns = namespace();
      const values: JsonValue[] = [
        "text",
        "",
        0,
        1.5,
        -3,
        true,
        false,
        null,
        [],
        [1, "a", null, { deep: true }],
        { nested: { list: [1, 2, 3], flag: false }, "unicode-🎉": "héllo→🎉" },
      ];
      for (const [index, value] of values.entries()) {
        const put = await run(d.put(ns, `k${index}`, value));
        expect(put.value).toEqual(value);
        expect(put.version).toBe(1);
        expect(put.namespace).toBe(ns);
        expect(put.key).toBe(`k${index}`);
        expect(Number.isNaN(Date.parse(put.updatedAt))).toBe(false);
        const got = await run(d.get(ns, `k${index}`));
        expect(got?.value).toEqual(value);
        expect(got?.version).toBe(1);
      }
    }, timeout);

    test("unconditional overwrites bump the version and replace the value", async () => {
      const d = await db();
      const ns = namespace();
      await run(d.put(ns, "k", { generation: 1 }));
      const second = await run(d.put(ns, "k", { generation: 2 }));
      expect(second.version).toBe(2);
      const got = await run(d.get(ns, "k"));
      expect(got?.value).toEqual({ generation: 2 });
      expect(got?.version).toBe(2);
    }, timeout);

    test("conditional create succeeds once, then conflicts until the key is deleted", async () => {
      const d = await db();
      const ns = namespace();
      const first = await run(d.put(ns, "k", "one", { ifNoneMatch: "*" }));
      expect(first.version).toBe(1);
      expectConflict(await attempt(d.put(ns, "k", "two", { ifNoneMatch: "*" })), ns, "k");
      expect((await run(d.get(ns, "k")))?.value).toBe("one");
      await run(d.delete(ns, "k"));
      expect((await run(d.put(ns, "k", "three", { ifNoneMatch: "*" }))).version).toBe(1);
    }, timeout);

    test("conditional update succeeds on the exact version and conflicts on any other", async () => {
      const d = await db();
      const ns = namespace();
      const created = await run(d.put(ns, "k", "v1"));
      const updated = await run(d.put(ns, "k", "v2", { ifMatch: created.version }));
      expect(updated.version).toBe(created.version + 1);
      expectConflict(await attempt(d.put(ns, "k", "stale", { ifMatch: created.version })), ns, "k");
      expectConflict(await attempt(d.put(ns, "k", "future", { ifMatch: created.version + 5 })), ns, "k");
      expectConflict(await attempt(d.put(ns, "absent", "v", { ifMatch: 1 })), ns, "absent");
      expect((await run(d.get(ns, "k")))?.value).toBe("v2");
    }, timeout);

    test("combining both write preconditions is rejected as invalid, not as a conflict", async () => {
      const d = await db();
      const ns = namespace();
      expectError(await attempt(d.put(ns, "k", "v", { ifNoneMatch: "*", ifMatch: 1 })));
      expectError(await attempt(d.put(ns, "k", "v", { ifMatch: 0 })));
      expectError(await attempt(d.put(ns, "k", "v", { ifMatch: 1.5 })));
    }, timeout);

    test("conditional delete honors the version precondition", async () => {
      const d = await db();
      const ns = namespace();
      const record = await run(d.put(ns, "k", "v"));
      expectConflict(await attempt(d.delete(ns, "k", { ifMatch: record.version + 1 })), ns, "k");
      expect(await run(d.get(ns, "k"))).not.toBeNull();
      await run(d.delete(ns, "k", { ifMatch: record.version }));
      expect(await run(d.get(ns, "k"))).toBeNull();
      expectConflict(await attempt(d.delete(ns, "k", { ifMatch: record.version })), ns, "k");
    }, timeout);

    test("namespaces isolate records completely", async () => {
      const d = await db();
      const left = namespace();
      const right = namespace();
      await run(d.put(left, "shared-key", "left"));
      await run(d.put(right, "shared-key", "right"));
      await run(d.delete(left, "shared-key"));
      expect(await run(d.get(left, "shared-key"))).toBeNull();
      expect((await run(d.get(right, "shared-key")))?.value).toBe("right");
      expect((await run(d.list(left))).records).toHaveLength(0);
    }, timeout);

    test("listing returns UTF-8 byte order, honors prefixes, and paginates exclusively", async () => {
      const d = await db();
      const ns = namespace();
      // Insertion order is deliberately scrambled; expected order is UTF-8
      // byte order ("a/b" < "ab" because 0x2F < 0x62; "é" sorts after "~").
      const ordered = ["a", "a/b", "a/c", "ab", "b", "z", "~tilde", "é-accent"];
      for (const key of [...ordered].reverse()) {
        await run(d.put(ns, key, `value:${key}`));
      }

      const full = await run(d.list(ns));
      expect(full.records.map((record) => record.key)).toEqual(ordered);

      const prefixed = await run(d.list(ns, { prefix: "a/" }));
      expect(prefixed.records.map((record) => record.key)).toEqual(["a/b", "a/c"]);
      const bare = await run(d.list(ns, { prefix: "a" }));
      expect(bare.records.map((record) => record.key)).toEqual(["a", "a/b", "a/c", "ab"]);

      const after = await run(d.list(ns, { prefix: "a", startAfter: "a/b" }));
      expect(after.records.map((record) => record.key)).toEqual(["a/c", "ab"]);

      const paged: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await run(d.list(ns, { limit: 3, startAfter: cursor }));
        expect(page.records.length).toBeLessThanOrEqual(3);
        paged.push(...page.records.map((record) => record.key));
        cursor = page.cursor;
        pages += 1;
        if (pages > 10) throw new Error("pagination did not terminate");
      } while (cursor != null);
      expect(paged).toEqual(ordered);
    }, timeout);

    test("list limits and cursors are validated", async () => {
      const d = await db();
      const ns = namespace();
      for (const limit of [0, -5, 1.5, 1001]) {
        expectError(await attempt(d.list(ns, { limit })));
      }
      expectError(await attempt(d.list(ns, { startAfter: "/bad" })));
      expectError(await attempt(d.list(ns, { prefix: "bad//prefix" })));
    }, timeout);

    test("unsafe namespaces and keys are rejected identically across operations", async () => {
      const d = await db();
      const ns = namespace();
      for (const bad of ["", " ", "-leading", "ns/slash", "x".repeat(129)]) {
        expectError(await attempt(d.get(bad, "k")));
        expectError(await attempt(d.put(bad, "k", "v")));
        expectError(await attempt(d.delete(bad, "k")));
        expectError(await attempt(d.list(bad)));
      }
      for (const bad of ["", "/lead", "a//b", "a/./b", "a/../b", "back\\slash", "nul\0", ".", "..", "x".repeat(1025)]) {
        expectError(await attempt(d.get(ns, bad)));
        expectError(await attempt(d.put(ns, bad, "v")));
        expectError(await attempt(d.delete(ns, bad)));
      }
    }, timeout);

    test("non-JSON-serializable values are rejected before they reach the backend", async () => {
      const d = await db();
      const ns = namespace();
      expectError(await attempt(d.put(ns, "k", Number.NaN as unknown as JsonValue)));
      expectError(await attempt(d.put(ns, "k", Number.POSITIVE_INFINITY as unknown as JsonValue)));
      expect(await run(d.get(ns, "k"))).toBeNull();
    }, timeout);

    test("expired records read as absent and their keys accept a fresh conditional create", async () => {
      const d = await db();
      const ns = namespace();
      const now = Math.floor(Date.now() / 1000);
      await run(d.put(ns, "gone", "expired", { expiresAt: now - 10 }));
      await run(d.put(ns, "alive", "current", { expiresAt: now + 3600 }));
      expect(await run(d.get(ns, "gone"))).toBeNull();
      expect((await run(d.get(ns, "alive")))?.value).toBe("current");
      expect((await run(d.list(ns))).records.map((record) => record.key)).toEqual(["alive"]);
      const recreated = await run(d.put(ns, "gone", "fresh", { ifNoneMatch: "*", expiresAt: now + 3600 }));
      expect(recreated.version).toBe(1);
      expectError(await attempt(d.put(ns, "k", "v", { expiresAt: 0 })));
      expectError(await attempt(d.put(ns, "k", "v", { expiresAt: 1.5 })));
    }, timeout);

    test("concurrent conditional creates admit exactly one winner", async () => {
      const d = await db();
      const ns = namespace();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) => attempt(d.put(ns, "seat", `writer-${index}`, { ifNoneMatch: "*" }))),
      );
      const winners = results.filter(Either.isRight);
      expect(winners).toHaveLength(1);
      for (const loser of results.filter(Either.isLeft)) {
        expect(loser.left._tag).toBe("PrimitiveDbConflict");
      }
      expect((await run(d.get(ns, "seat")))?.value).toBe(winners[0].right.value);
    }, timeout);

    test("concurrent conditional updates from one version admit exactly one winner", async () => {
      const d = await db();
      const ns = namespace();
      const created = await run(d.put(ns, "doc", "base"));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) => attempt(d.put(ns, "doc", `writer-${index}`, { ifMatch: created.version }))),
      );
      const winners = results.filter(Either.isRight);
      expect(winners).toHaveLength(1);
      const final = await run(d.get(ns, "doc"));
      expect(final?.value).toBe(winners[0].right.value);
      expect(final?.version).toBe(created.version + 1);
    }, timeout);
  });
}
