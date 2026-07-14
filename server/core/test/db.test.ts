import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeMemoryPrimitiveDb, safeDbKey, safeDbKeyPrefix, safeDbNamespace } from "../src/db";

describe("PrimitiveDb", () => {
  test("stores and reads JSON records with versions", async () => {
    const db = makeMemoryPrimitiveDb();
    const created = await Effect.runPromise(db.put("projects", "alice/docs", { revision: "rev-1" }, { ifNoneMatch: "*" }));
    expect(created.version).toBe(1);
    expect(created.value).toEqual({ revision: "rev-1" });

    const updated = await Effect.runPromise(db.put("projects", "alice/docs", { revision: "rev-2" }, { ifMatch: created.version }));
    expect(updated.version).toBe(2);

    const loaded = await Effect.runPromise(db.get("projects", "alice/docs"));
    expect(loaded?.value).toEqual({ revision: "rev-2" });
    expect(loaded?.version).toBe(2);
  });

  test("enforces create and update preconditions", async () => {
    const db = makeMemoryPrimitiveDb();
    const created = await Effect.runPromise(db.put("projects", "alice/docs", { ok: true }, { ifNoneMatch: "*" }));

    await expect(Effect.runPromise(db.put("projects", "alice/docs", { ok: false }, { ifNoneMatch: "*" }))).rejects.toThrow("Record already exists");
    await expect(Effect.runPromise(db.put("projects", "alice/docs", { ok: false }, { ifMatch: created.version + 1 }))).rejects.toThrow("Record version mismatch");

    const updated = await Effect.runPromise(db.put("projects", "alice/docs", { ok: false }, { ifMatch: created.version }));
    expect(updated.version).toBe(2);
  });

  test("lists records by namespace and prefix", async () => {
    const db = makeMemoryPrimitiveDb();
    await Effect.runPromise(db.put("projects", "alice/a", { n: 1 }));
    await Effect.runPromise(db.put("projects", "alice/b", { n: 2 }));
    await Effect.runPromise(db.put("projects", "bob/a", { n: 3 }));
    await Effect.runPromise(db.put("users", "alice", { n: 4 }));

    const listed = await Effect.runPromise(db.list("projects", { prefix: "alice/" }));
    expect(listed.records.map((record) => record.key)).toEqual(["alice/a", "alice/b"]);
  });

  test("lists records in backend byte order", async () => {
    const db = makeMemoryPrimitiveDb();
    for (const key of ["alice/_", "alice/-", "alice/0", "alice/a", "alice/Z"]) {
      await Effect.runPromise(db.put("projects", key, { key }));
    }

    const listed = await Effect.runPromise(db.list("projects", { prefix: "alice/" }));
    expect(listed.records.map((record) => record.key)).toEqual(["alice/-", "alice/0", "alice/Z", "alice/_", "alice/a"]);
  });

  test("paginates lists with startAfter cursors", async () => {
    const db = makeMemoryPrimitiveDb();
    for (const key of ["alice/a", "alice/b", "alice/c", "alice/d", "alice/e"]) {
      await Effect.runPromise(db.put("projects", key, { key }));
    }

    const first = await Effect.runPromise(db.list("projects", { prefix: "alice/", limit: 2 }));
    expect(first.records.map((record) => record.key)).toEqual(["alice/a", "alice/b"]);
    expect(first.cursor).toBe("alice/b");

    const second = await Effect.runPromise(db.list("projects", { prefix: "alice/", limit: 2, startAfter: first.cursor }));
    expect(second.records.map((record) => record.key)).toEqual(["alice/c", "alice/d"]);
    expect(second.cursor).toBe("alice/d");

    const last = await Effect.runPromise(db.list("projects", { prefix: "alice/", limit: 2, startAfter: second.cursor }));
    expect(last.records.map((record) => record.key)).toEqual(["alice/e"]);
    expect(last.cursor).toBeUndefined();

    await expect(Effect.runPromise(db.list("projects", { startAfter: "../etc" }))).rejects.toThrow("Invalid database list cursor");
  });

  test("delete can be version-checked", async () => {
    const db = makeMemoryPrimitiveDb();
    const created = await Effect.runPromise(db.put("projects", "alice/docs", { ok: true }));
    await expect(Effect.runPromise(db.delete("projects", "alice/docs", { ifMatch: 0 }))).rejects.toThrow("ifMatch must be a positive integer version");
    await expect(Effect.runPromise(db.delete("projects", "alice/docs", { ifMatch: created.version + 1 }))).rejects.toThrow("Record version mismatch");
    await Effect.runPromise(db.delete("projects", "alice/docs", { ifMatch: created.version }));
    expect(await Effect.runPromise(db.get("projects", "alice/docs"))).toBeNull();
  });

  test("validates namespaces, keys, and JSON values", async () => {
    const db = makeMemoryPrimitiveDb();
    expect(safeDbNamespace("projects:by-owner")).toBe(true);
    expect(safeDbNamespace("/projects")).toBe(false);
    expect(safeDbKey("alice/docs")).toBe(true);
    expect(safeDbKey("../docs")).toBe(false);
    expect(safeDbKeyPrefix("alice/")).toBe(true);

    await expect(Effect.runPromise(db.put("projects", "alice/docs", { value: Number.NaN }))).rejects.toThrow("Database value must be JSON-serializable");
  });

  test("expires records and lets conditional creates reuse elapsed keys", async () => {
    const db = makeMemoryPrimitiveDb();
    const realNow = Date.now;
    try {
      Date.now = () => 10_000;
      await Effect.runPromise(db.put("codes", "one", { redeemed: true }, { ifNoneMatch: "*", expiresAt: 11 }));
      await expect(Effect.runPromise(db.put("codes", "one", { redeemed: true }, { ifNoneMatch: "*", expiresAt: 11 }))).rejects.toThrow("already exists");
      Date.now = () => 12_000;
      expect(await Effect.runPromise(db.get("codes", "one"))).toBeNull();
      await Effect.runPromise(db.put("codes", "one", { redeemed: true }, { ifNoneMatch: "*", expiresAt: 13 }));
      expect((await Effect.runPromise(db.list("codes"))).records).toHaveLength(1);
      Date.now = () => 14_000;
      expect((await Effect.runPromise(db.list("codes"))).records).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
  });
});
