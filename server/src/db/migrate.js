#!/usr/bin/env bun
/*
 * Migration runner — brings a database up to the current schema.
 *
 * Strategy (mirrors how deploy.sh drives D1 with wrangler):
 *   1. Apply every file in src/db/migrations/ in filename order. These are the
 *      incremental, non-idempotent deltas (column adds, backfills) needed by
 *      databases that predate a change. Errors that just mean "already applied"
 *      (a duplicate column, an existing object) are tolerated so the run stays
 *      idempotent; anything else aborts.
 *   2. Apply schema.sql. Every statement there is IF NOT EXISTS, so this creates
 *      whatever is still missing and is a safe no-op on an up-to-date database.
 *
 * This module runs only in Bun / Node (it reads .sql files off disk) — never
 * inside the Worker. Locally the server calls openSqliteDb() on startup;
 * production applies the same files to D1 through wrangler in deploy.sh.
 *
 * As a CLI:  bun src/db/migrate.js [--data DIR]   (default ./.scratchwork-data)
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createSqliteClient } from "./client.js";

const DB_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(DB_DIR, "schema.sql");
const MIGRATIONS_DIR = join(DB_DIR, "migrations");

// Substrings that mark an error as "this delta was already applied" rather than
// a real failure — the same classes wrangler/D1 and bun:sqlite report.
const ALREADY_APPLIED = ["already exists", "duplicate column"];

async function sqlFilesIn(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return []; // no migrations dir yet — fine
  }
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

/**
 * Apply pending migrations and the canonical schema to a db client.
 * Returns the list of migration filenames that were run (for logging/tests).
 */
export async function migrate(client) {
  const applied = [];
  for (const file of await sqlFilesIn(MIGRATIONS_DIR)) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await client.exec(sql);
      applied.push(file);
    } catch (e) {
      const msg = (e?.message || String(e)).toLowerCase();
      if (ALREADY_APPLIED.some((s) => msg.includes(s))) continue;
      throw new Error(`migration ${file} failed: ${e?.message || e}`);
    }
  }
  await client.exec(await readFile(SCHEMA_PATH, "utf8"));
  return applied;
}

/**
 * Open the local bun:sqlite database, enable foreign-key enforcement and WAL,
 * run migrations, and return { client, raw }. `:memory:` is accepted for tests.
 */
export async function openSqliteDb(path) {
  const { Database } = await import("bun:sqlite");
  let target = ":memory:";
  if (path !== ":memory:") {
    target = resolve(path);
    await mkdir(dirname(target), { recursive: true }); // SQLite won't create parent dirs
  }
  const raw = new Database(target, { create: true });
  // SQLite leaves FK enforcement off per-connection; turn it on so the schema's
  // ON DELETE CASCADE / SET NULL rules actually fire. WAL improves concurrent
  // read/write behaviour for the local server.
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const client = createSqliteClient(raw);
  await migrate(client);
  return { client, raw };
}

// CLI: migrate the local database file under the data dir.
if (import.meta.main) {
  const args = process.argv.slice(2);
  let dataDir = process.env.SCRATCHWORK_DATA || "./.scratchwork-data";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data") dataDir = args[++i];
    else if (args[i].startsWith("--data=")) dataDir = args[i].slice("--data=".length);
    else {
      console.error(`migrate: unknown argument "${args[i]}"`);
      process.exit(1);
    }
  }
  const dbPath = join(resolve(dataDir), "scratchwork.sqlite");
  const { raw } = await openSqliteDb(dbPath);
  raw.close();
  console.log(`migrated ${dbPath}`);
}
