import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeMemoryPrimitiveDb, safeDbKey, safeDbKeyPrefix, safeDbNamespace } from "../src/db";

describe("PrimitiveDb", () => {
  test("stores and reads JSON records with versions", async () => {
    const db = makeMemoryPrimitiveDb();
    const created = await Effect.runPromise(db.put("projects", "alice/docs", { visibility: "private" }, { ifNoneMatch: "*" }));
    expect(created.version).toBe(1);
    expect(created.value).toEqual({ visibility: "private" });

    const updated = await Effect.runPromise(db.put("projects", "alice/docs", { visibility: "@example.com" }, { ifMatch: created.version }));
    expect(updated.version).toBe(2);

    const loaded = await Effect.runPromise(db.get("projects", "alice/docs"));
    expect(loaded?.value).toEqual({ visibility: "@example.com" });
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

  test("delete can be version-checked", async () => {
    const db = makeMemoryPrimitiveDb();
    const created = await Effect.runPromise(db.put("projects", "alice/docs", { ok: true }));
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
});
