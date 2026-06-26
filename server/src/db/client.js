/*
 * Database client — one tagged-template interface over two backends.
 *
 * The rest of the server talks to the database through a single small surface so
 * that the same query code runs unchanged on Cloudflare D1 (production) and on
 * bun:sqlite (local), exactly as the storage adapters do for blobs. Queries are
 * written as tagged template literals; interpolations become bound parameters,
 * so values are never string-concatenated into SQL:
 *
 *     const rows = await db`SELECT * FROM user WHERE email = ${email}`;
 *     const u    = await db.get`SELECT * FROM user WHERE id = ${id}`;     // row|null
 *     await db.run`UPDATE session SET expires_at = ${exp} WHERE id = ${id}`;
 *
 * The client is intentionally tiny: no query builder, no ORM, no migrations
 * framework. Multi-statement scripts (schema.sql, migration files) go through
 * .exec(), which is only used by the migration runner.
 */

// `?` placeholders for D1/SQLite; map `undefined` → `null` (both backends reject
// undefined bindings). A tagged template `sql\`a ${x} b ${y}\`` has N+1 string
// fragments and N values, so one placeholder is emitted between fragments.
function buildQuery(strings, values) {
  let sql = strings[0];
  for (let i = 0; i < values.length; i++) sql += "?" + strings[i + 1];
  const params = values.map((v) => (v === undefined ? null : v));
  return { sql, params };
}

// Attach the query "methods" (.query/.get/.run/.exec) to a callable so the
// client can be used either as a tag (db`...`) or as db.get`...`, etc.
function makeClient({ all, first, run, exec }) {
  const tag = (strings, ...values) => all(buildQuery(strings, values));
  tag.query = tag;
  tag.get = (strings, ...values) => first(buildQuery(strings, values));
  tag.run = (strings, ...values) => run(buildQuery(strings, values));
  tag.exec = (sqlText) => exec(sqlText);
  return tag;
}

/*
 * Cloudflare D1 adapter. D1's prepared statements take positional bindings and
 * return { results } from .all(). .exec() runs a semicolon-separated script and
 * is only exercised by tests / fallback tooling — production migrations are
 * applied by wrangler in deploy.sh, not through this method.
 */
export function createD1Client(db) {
  const prep = ({ sql, params }) => db.prepare(sql).bind(...params);
  return makeClient({
    all: async (q) => (await prep(q).all()).results ?? [],
    first: async (q) => (await prep(q).first()) ?? null,
    run: async (q) => {
      const { meta } = await prep(q).run();
      return { changes: meta?.changes ?? 0, lastRowId: meta?.last_row_id ?? null };
    },
    exec: async (sqlText) => {
      await db.exec(sqlText);
    },
  });
}

/*
 * bun:sqlite adapter. Statements are positional (`?`), bound via the spread
 * params on .all()/.get()/.run(). Foreign-key enforcement is enabled on the
 * connection by openSqliteDb (see migrate.js) so the schema's ON DELETE CASCADE
 * rules actually fire — SQLite leaves them off otherwise.
 */
export function createSqliteClient(db) {
  return makeClient({
    all: async ({ sql, params }) => db.query(sql).all(...params),
    first: async ({ sql, params }) => db.query(sql).get(...params) ?? null,
    run: async ({ sql, params }) => {
      const r = db.query(sql).run(...params);
      return { changes: r.changes ?? 0, lastRowId: r.lastInsertRowid ?? null };
    },
    exec: async (sqlText) => {
      db.exec(sqlText);
    },
  });
}
