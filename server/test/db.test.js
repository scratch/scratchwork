/*
 * Data-layer tests (Phase 1). These exercise the runtime-agnostic database
 * surface the auth/projects layers will build on:
 *
 *   - the bun:sqlite client against a real, migrated in-memory database
 *     (the exact path the local server uses);
 *   - the migration runner's idempotency and the schema's table set;
 *   - the D1 client's SQL shaping, against a fake D1 that records what it gets
 *     (no wrangler/miniflare needed).
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteClient, createD1Client } from "../src/db/client.js";
import { migrate, openSqliteDb } from "../src/db/migrate.js";

const EXPECTED_TABLES = ["account", "apikey", "device_code", "project", "session", "share_token", "user"];

async function freshDb() {
  // openSqliteDb runs migrations and turns on foreign keys, exactly like prod-local.
  const { client, raw } = await openSqliteDb(":memory:");
  return { db: client, raw, close: () => raw.close() };
}

describe("schema + migrations", () => {
  test("migrate creates the full table set and is idempotent", async () => {
    const raw = new Database(":memory:");
    raw.exec("PRAGMA foreign_keys = ON;");
    const db = createSqliteClient(raw);

    const firstRun = await migrate(db); // no delta files yet
    expect(firstRun).toEqual([]);
    await migrate(db); // running again must not throw

    const tables = (
      await db`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).map((r) => r.name);
    expect(tables).toEqual(EXPECTED_TABLES);
    raw.close();
  });

  test("default timestamps are populated on insert", async () => {
    const t = await freshDb();
    try {
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${"a@b.com"}, ${"a"})`;
      const u = await t.db.get`SELECT created_at, updated_at FROM user WHERE id = ${"u1"}`;
      expect(u.created_at).toBeTruthy();
      expect(u.updated_at).toBeTruthy();
    } finally {
      t.close();
    }
  });
});

describe("sqlite client", () => {
  test("tagged-template values are bound, not interpolated (injection-safe)", async () => {
    const t = await freshDb();
    try {
      // A value that would be catastrophic if concatenated into SQL.
      const evil = "x'); DROP TABLE user; --";
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${evil}, ${"slug1"})`;
      const got = await t.db.get`SELECT email FROM user WHERE id = ${"u1"}`;
      expect(got.email).toBe(evil); // stored verbatim
      // The table still exists and the row is intact — the payload was data.
      const all = await t.db`SELECT id FROM user`;
      expect(all.length).toBe(1);
    } finally {
      t.close();
    }
  });

  test(".get returns a single row or null; query returns an array", async () => {
    const t = await freshDb();
    try {
      expect(await t.db.get`SELECT * FROM user WHERE id = ${"missing"}`).toBeNull();
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${"a@b.com"}, ${"a"})`;
      const row = await t.db.get`SELECT slug FROM user WHERE id = ${"u1"}`;
      expect(row.slug).toBe("a");
      const rows = await t.db`SELECT slug FROM user`;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(1);
    } finally {
      t.close();
    }
  });

  test(".run reports the number of changed rows", async () => {
    const t = await freshDb();
    try {
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${"a@b.com"}, ${"a"})`;
      const r = await t.db.run`UPDATE user SET name = ${"Ada"} WHERE id = ${"u1"}`;
      expect(r.changes).toBe(1);
      const none = await t.db.run`UPDATE user SET name = ${"x"} WHERE id = ${"nope"}`;
      expect(none.changes).toBe(0);
    } finally {
      t.close();
    }
  });

  test("undefined interpolations bind as NULL", async () => {
    const t = await freshDb();
    try {
      let name; // undefined
      await t.db`INSERT INTO user (id, email, slug, name) VALUES (${"u1"}, ${"a@b.com"}, ${"a"}, ${name})`;
      const u = await t.db.get`SELECT name FROM user WHERE id = ${"u1"}`;
      expect(u.name).toBeNull();
    } finally {
      t.close();
    }
  });

  test("unique constraints are enforced (email, slug, project name per owner)", async () => {
    const t = await freshDb();
    try {
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${"a@b.com"}, ${"a"})`;
      // Duplicate email
      await expect(t.db`INSERT INTO user (id, email, slug) VALUES (${"u2"}, ${"a@b.com"}, ${"b"})`).rejects.toThrow();
      // Duplicate slug
      await expect(t.db`INSERT INTO user (id, email, slug) VALUES (${"u3"}, ${"c@d.com"}, ${"a"})`).rejects.toThrow();

      // A project name is unique per owner, not globally.
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u2"}, ${"e@f.com"}, ${"e"})`;
      await t.db`INSERT INTO project (id, owner_id, name) VALUES (${"p1"}, ${"u1"}, ${"site"})`;
      await t.db`INSERT INTO project (id, owner_id, name) VALUES (${"p2"}, ${"u2"}, ${"site"})`; // ok: different owner
      await expect(
        t.db`INSERT INTO project (id, owner_id, name) VALUES (${"p3"}, ${"u1"}, ${"site"})`,
      ).rejects.toThrow(); // same owner + name
    } finally {
      t.close();
    }
  });

  test("foreign keys cascade on owner delete", async () => {
    const t = await freshDb();
    try {
      await t.db`INSERT INTO user (id, email, slug) VALUES (${"u1"}, ${"a@b.com"}, ${"a"})`;
      await t.db`INSERT INTO project (id, owner_id, name) VALUES (${"p1"}, ${"u1"}, ${"site"})`;
      await t.db`INSERT INTO share_token (id, project_id, token) VALUES (${"s1"}, ${"p1"}, ${"tok"})`;
      await t.db`DELETE FROM user WHERE id = ${"u1"}`;
      expect((await t.db`SELECT id FROM project`).length).toBe(0); // cascaded
      expect((await t.db`SELECT id FROM share_token`).length).toBe(0); // cascaded transitively
    } finally {
      t.close();
    }
  });

  test("a foreign key to a missing row is rejected", async () => {
    const t = await freshDb();
    try {
      await expect(
        t.db`INSERT INTO project (id, owner_id, name) VALUES (${"p1"}, ${"ghost"}, ${"site"})`,
      ).rejects.toThrow();
    } finally {
      t.close();
    }
  });
});

describe("d1 client (fake D1)", () => {
  // A minimal stand-in for D1Database that records the SQL + bindings and lets
  // each test script the rows returned. Verifies the adapter builds positional
  // SQL and threads results/metadata through .all/.first/.run.
  function fakeD1(plan = {}) {
    const calls = [];
    const db = {
      calls,
      prepare(sql) {
        const rec = { sql, params: [] };
        return {
          bind(...params) {
            rec.params = params;
            return this;
          },
          async all() {
            calls.push({ ...rec, method: "all" });
            return { results: plan.results ?? [], meta: plan.meta ?? {} };
          },
          async first() {
            calls.push({ ...rec, method: "first" });
            return plan.first ?? null;
          },
          async run() {
            calls.push({ ...rec, method: "run" });
            return { meta: plan.meta ?? {} };
          },
        };
      },
    };
    return db;
  }

  test("interpolations become positional ? params in order", async () => {
    const fake = fakeD1({ results: [{ id: "u1" }] });
    const db = createD1Client(fake);
    const rows = await db`SELECT * FROM user WHERE email = ${"a@b.com"} AND slug = ${"a"}`;
    expect(rows).toEqual([{ id: "u1" }]);
    expect(fake.calls[0].sql).toBe("SELECT * FROM user WHERE email = ? AND slug = ?");
    expect(fake.calls[0].params).toEqual(["a@b.com", "a"]);
    expect(fake.calls[0].method).toBe("all");
  });

  test(".get maps to first() and returns null when empty", async () => {
    const db = createD1Client(fakeD1({ first: null }));
    expect(await db.get`SELECT 1 WHERE 1 = ${0}`).toBeNull();

    const db2 = createD1Client(fakeD1({ first: { id: "u1" } }));
    expect(await db2.get`SELECT * FROM user WHERE id = ${"u1"}`).toEqual({ id: "u1" });
  });

  test(".run surfaces D1 meta.changes / last_row_id", async () => {
    const db = createD1Client(fakeD1({ meta: { changes: 3, last_row_id: 42 } }));
    const r = await db.run`UPDATE user SET name = ${"x"}`;
    expect(r).toEqual({ changes: 3, lastRowId: 42 });
  });

  test("undefined interpolation binds as null", async () => {
    const fake = fakeD1();
    const db = createD1Client(fake);
    let v;
    await db`INSERT INTO user (name) VALUES (${v})`;
    expect(fake.calls[0].params).toEqual([null]);
  });
});
