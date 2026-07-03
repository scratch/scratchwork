import {
  PrimitiveDb,
  PrimitiveDbConflict,
  PrimitiveDbError,
  decodePrimitiveDbValue,
  encodePrimitiveDbValue,
  normalizeListLimit,
  normalizeListStartAfter,
  requireSafeDbKey,
  requireSafeDbKeyPrefix,
  requireSafeDbNamespace,
  validateDeleteOptions,
  validatePutOptions,
  type JsonValue,
  type DeletePrimitiveDbRecordOptions,
  type ListPrimitiveDbRecordsOptions,
  type PrimitiveDbRecord,
  type PrimitiveDbShape,
  type PutPrimitiveDbRecordOptions,
} from "@scratchwork/server-core/db";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The subset of Cloudflare's D1 binding the adapter uses. */
export interface D1DatabaseBinding {
  readonly prepare: (query: string) => D1PreparedStatementBinding;
}

/** One prepared D1 statement. */
export interface D1PreparedStatementBinding {
  readonly bind: (...values: ReadonlyArray<string | number>) => D1PreparedStatementBinding;
  readonly first: <A = unknown>() => Promise<A | null>;
  readonly all: <A = unknown>() => Promise<{ readonly results: ReadonlyArray<A> }>;
  readonly run: () => Promise<{ readonly meta?: { readonly changes?: number } }>;
}

/** Layer options: table name and whether to CREATE TABLE IF NOT EXISTS on startup. */
export interface D1PrimitiveDbOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
}

/** One row of the records table. */
interface D1RecordRow {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly version: number;
  readonly updated_at: string;
}

const DEFAULT_TABLE = "scratchwork_records";
const DEFAULT_QUOTED_TABLE = `"${DEFAULT_TABLE}"`;

/** Adapts a Cloudflare D1 binding to the primitive DB contract. */
export function D1PrimitiveDbLive(
  database: D1DatabaseBinding,
  options: D1PrimitiveDbOptions = {},
): Layer.Layer<PrimitiveDb, PrimitiveDbError> {
  return Layer.effect(
    PrimitiveDb,
    Effect.gen(function* () {
      const table = yield* sqlIdentifier(options.tableName ?? DEFAULT_TABLE);
      if (options.ensureTable !== false) yield* ensureTable(database, table);
      return PrimitiveDb.of(makeD1PrimitiveDb(database, table));
    }),
  );
}

/** Creates the primitive DB shape over an existing D1 table. */
export function makeD1PrimitiveDb(database: D1DatabaseBinding, quotedTableName = DEFAULT_QUOTED_TABLE): PrimitiveDbShape {
  const get: PrimitiveDbShape["get"] = <A extends JsonValue = JsonValue>(namespace: string, key: string) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      const row = yield* d1First<D1RecordRow>(database, `SELECT namespace, key, value, version, updated_at FROM ${quotedTableName} WHERE namespace = ? AND key = ?`, [namespace, key]);
      return row == null ? null : yield* rowToRecord<A>(row);
    });

  const put: PrimitiveDbShape["put"] = <A extends JsonValue = JsonValue>(namespace: string, key: string, value: A, options?: PutPrimitiveDbRecordOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      yield* validatePutOptions(options);
      const encoded = yield* encodePrimitiveDbValue(value);
      const updatedAt = new Date().toISOString();

      if (options?.ifNoneMatch === "*") {
        const row = yield* d1First<D1RecordRow>(
          database,
          `INSERT INTO ${quotedTableName} (namespace, key, value, version, updated_at) VALUES (?, ?, ?, 1, ?) RETURNING namespace, key, value, version, updated_at`,
          [namespace, key, encoded, updatedAt],
          (cause) => isConstraintError(cause) ? new PrimitiveDbConflict({ namespace, key, message: `Record already exists: ${namespace}/${key}` }) : undefined,
        );
        if (row == null) {
          return yield* Effect.fail(new PrimitiveDbError({ message: `D1 did not return record: ${namespace}/${key}` }));
        }
        return yield* rowToRecord<A>(row);
      }

      if (options?.ifMatch != null) {
        const row = yield* d1First<D1RecordRow>(
          database,
          `UPDATE ${quotedTableName} SET value = ?, version = version + 1, updated_at = ? WHERE namespace = ? AND key = ? AND version = ? RETURNING namespace, key, value, version, updated_at`,
          [encoded, updatedAt, namespace, key, options.ifMatch],
        );
        if (row == null) {
          return yield* Effect.fail(new PrimitiveDbConflict({ namespace, key, message: `Record version mismatch: ${namespace}/${key}` }));
        }
        return yield* rowToRecord<A>(row);
      }

      const row = yield* d1First<D1RecordRow>(
        database,
        `INSERT INTO ${quotedTableName} (namespace, key, value, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, version = version + 1, updated_at = excluded.updated_at RETURNING namespace, key, value, version, updated_at`,
        [namespace, key, encoded, updatedAt],
      );
      if (row == null) {
        return yield* Effect.fail(new PrimitiveDbError({ message: `D1 did not return record: ${namespace}/${key}` }));
      }
      return yield* rowToRecord<A>(row);
    });

  const deleteRecord: PrimitiveDbShape["delete"] = (namespace: string, key: string, options?: DeletePrimitiveDbRecordOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      yield* validateDeleteOptions(options);
      const result = yield* d1Run(
        database,
        options?.ifMatch == null
          ? `DELETE FROM ${quotedTableName} WHERE namespace = ? AND key = ?`
          : `DELETE FROM ${quotedTableName} WHERE namespace = ? AND key = ? AND version = ?`,
        options?.ifMatch == null ? [namespace, key] : [namespace, key, options.ifMatch],
      );
      if (options?.ifMatch != null && (result.meta?.changes ?? 0) === 0) {
        return yield* Effect.fail(new PrimitiveDbConflict({ namespace, key, message: `Record version mismatch: ${namespace}/${key}` }));
      }
    });

  const list: PrimitiveDbShape["list"] = <A extends JsonValue = JsonValue>(namespace: string, options?: ListPrimitiveDbRecordsOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      const prefix = options?.prefix ?? "";
      yield* requireSafeDbKeyPrefix(prefix);
      const startAfter = yield* normalizeListStartAfter(options?.startAfter);
      const limit = yield* normalizeListLimit(options?.limit);
      const where = ["namespace = ?"];
      const values: Array<string | number> = [namespace];
      if (prefix !== "") {
        where.push("substr(key, 1, length(?)) = ?");
        values.push(prefix, prefix);
      }
      if (startAfter != null) {
        where.push("key > ?");
        values.push(startAfter);
      }
      const rows = yield* d1All<D1RecordRow>(
        database,
        `SELECT namespace, key, value, version, updated_at FROM ${quotedTableName} WHERE ${where.join(" AND ")} ORDER BY key LIMIT ?`,
        [...values, limit],
      );
      return {
        records: yield* Effect.all(rows.map((row) => rowToRecord<A>(row))),
        ...(rows.length === limit ? { cursor: rows[rows.length - 1].key } : {}),
      };
    });

  return { get, put, delete: deleteRecord, list };
}

/** Creates the records table when it does not already exist. */
function ensureTable(database: D1DatabaseBinding, quotedTableName: string): Effect.Effect<void, PrimitiveDbError> {
  return d1Run(database, `CREATE TABLE IF NOT EXISTS ${quotedTableName} (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  )`).pipe(Effect.asVoid);
}

/** Converts a table row back into the public record shape. */
function rowToRecord<A extends JsonValue>(row: D1RecordRow): Effect.Effect<PrimitiveDbRecord<A>, PrimitiveDbError> {
  return decodePrimitiveDbValue(row.value).pipe(
    Effect.map((value) => ({ namespace: row.namespace, key: row.key, value: value as A, version: row.version, updatedAt: row.updated_at })),
  );
}

/** Runs one D1 query and returns the first row, mapping causes via `mapCause` when given. */
function d1First<A>(
  database: D1DatabaseBinding,
  query: string,
  values?: ReadonlyArray<string | number>,
): Effect.Effect<A | null, PrimitiveDbError>;
function d1First<A>(
  database: D1DatabaseBinding,
  query: string,
  values: ReadonlyArray<string | number>,
  mapCause: (cause: unknown) => PrimitiveDbError | PrimitiveDbConflict | undefined,
): Effect.Effect<A | null, PrimitiveDbError | PrimitiveDbConflict>;
function d1First<A>(
  database: D1DatabaseBinding,
  query: string,
  values: ReadonlyArray<string | number> = [],
  mapCause?: (cause: unknown) => PrimitiveDbError | PrimitiveDbConflict | undefined,
): Effect.Effect<A | null, PrimitiveDbError | PrimitiveDbConflict> {
  return Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<A>(),
    catch: (cause) => mapCause?.(cause) ?? new PrimitiveDbError({ message: "D1 query failed", cause }),
  });
}

/** Runs one D1 query and returns every result row. */
function d1All<A>(database: D1DatabaseBinding, query: string, values: ReadonlyArray<string | number>): Effect.Effect<ReadonlyArray<A>, PrimitiveDbError> {
  return Effect.tryPromise({
    try: async () => (await database.prepare(query).bind(...values).all<A>()).results,
    catch: (cause) => new PrimitiveDbError({ message: "D1 query failed", cause }),
  });
}

/** Runs one D1 statement for its side effect and change count. */
function d1Run(database: D1DatabaseBinding, query: string, values: ReadonlyArray<string | number> = []): Effect.Effect<{ readonly meta?: { readonly changes?: number } }, PrimitiveDbError> {
  return Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).run(),
    catch: (cause) => new PrimitiveDbError({ message: "D1 query failed", cause }),
  });
}

/** Validates a table name and returns it double-quoted for interpolation into SQL. */
function sqlIdentifier(name: string): Effect.Effect<string, PrimitiveDbError> {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? Effect.succeed(`"${name}"`)
    : Effect.fail(new PrimitiveDbError({ message: `Invalid D1 table name: ${name}` }));
}

/** Detects D1 unique-constraint failures from their error message. */
function isConstraintError(cause: unknown): boolean {
  return String((cause as { readonly message?: unknown }).message ?? cause).toLowerCase().includes("constraint");
}
