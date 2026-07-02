import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class PrimitiveDbError extends Data.TaggedError("PrimitiveDbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PrimitiveDbConflict extends Data.TaggedError("PrimitiveDbConflict")<{
  readonly namespace: string;
  readonly key: string;
  readonly message: string;
}> {}

export interface PrimitiveDbRecord<A extends JsonValue = JsonValue> {
  readonly namespace: string;
  readonly key: string;
  readonly value: A;
  readonly version: number;
  readonly updatedAt: string;
}

export interface PutPrimitiveDbRecordOptions {
  readonly ifNoneMatch?: "*";
  readonly ifMatch?: number;
}

export interface DeletePrimitiveDbRecordOptions {
  readonly ifMatch?: number;
}

export interface ListPrimitiveDbRecordsOptions {
  readonly prefix?: string;
  readonly limit?: number;
  /** Exclusive pagination cursor: only keys strictly after this key are returned. */
  readonly startAfter?: string;
}

export interface PrimitiveDbListResult<A extends JsonValue = JsonValue> {
  readonly records: ReadonlyArray<PrimitiveDbRecord<A>>;
  /** Pass as startAfter to fetch the next page. Absent when the listing is complete. */
  readonly cursor?: string;
}

export interface PrimitiveDbShape {
  readonly get: <A extends JsonValue = JsonValue>(
    namespace: string,
    key: string,
  ) => Effect.Effect<PrimitiveDbRecord<A> | null, PrimitiveDbError>;
  readonly put: <A extends JsonValue = JsonValue>(
    namespace: string,
    key: string,
    value: A,
    options?: PutPrimitiveDbRecordOptions,
  ) => Effect.Effect<PrimitiveDbRecord<A>, PrimitiveDbError | PrimitiveDbConflict>;
  readonly delete: (
    namespace: string,
    key: string,
    options?: DeletePrimitiveDbRecordOptions,
  ) => Effect.Effect<void, PrimitiveDbError | PrimitiveDbConflict>;
  readonly list: <A extends JsonValue = JsonValue>(
    namespace: string,
    options?: ListPrimitiveDbRecordsOptions,
  ) => Effect.Effect<PrimitiveDbListResult<A>, PrimitiveDbError>;
}

export class PrimitiveDb extends Context.Tag("@scratchwork/server/PrimitiveDb")<
  PrimitiveDb,
  PrimitiveDbShape
>() {}

interface MemoryRecord {
  readonly encoded: string;
  readonly version: number;
  readonly updatedAt: string;
}

/** Provides an in-memory PrimitiveDb implementation for tests and local composition. */
export function MemoryPrimitiveDbLive(
  records = new Map<string, MemoryRecord>(),
): Layer.Layer<PrimitiveDb> {
  return Layer.succeed(PrimitiveDb, PrimitiveDb.of(makeMemoryPrimitiveDb(records)));
}

/** Creates a PrimitiveDb over a caller-owned map. */
export function makeMemoryPrimitiveDb(records = new Map<string, MemoryRecord>()): PrimitiveDbShape {
  const get: PrimitiveDbShape["get"] = <A extends JsonValue = JsonValue>(namespace: string, key: string) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      const record = records.get(memoryKey(namespace, key));
      return record == null ? null : yield* materializeRecord<A>(namespace, key, record);
    });

  const put: PrimitiveDbShape["put"] = <A extends JsonValue = JsonValue>(namespace: string, key: string, value: A, options?: PutPrimitiveDbRecordOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      yield* validatePutOptions(options);
      const encoded = yield* encodePrimitiveDbValue(value);
      const mapKey = memoryKey(namespace, key);
      const existing = records.get(mapKey);
      if (options?.ifNoneMatch === "*" && existing != null) {
        return yield* Effect.fail(new PrimitiveDbConflict({ namespace, key, message: `Record already exists: ${namespace}/${key}` }));
      }
      if (options?.ifMatch != null && existing?.version !== options.ifMatch) {
        return yield* Effect.fail(new PrimitiveDbConflict({ namespace, key, message: `Record version mismatch: ${namespace}/${key}` }));
      }

      const record: MemoryRecord = {
        encoded,
        version: existing == null ? 1 : existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      records.set(mapKey, record);
      return yield* materializeRecord<A>(namespace, key, record);
    });

  const deleteRecord: PrimitiveDbShape["delete"] = (namespace, key, options) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      const mapKey = memoryKey(namespace, key);
      const existing = records.get(mapKey);
      yield* validateDeleteOptions(options);
      if (options?.ifMatch != null && existing?.version !== options.ifMatch) {
        return yield* Effect.fail(new PrimitiveDbConflict({ namespace, key, message: `Record version mismatch: ${namespace}/${key}` }));
      }
      records.delete(mapKey);
    });

  const list: PrimitiveDbShape["list"] = <A extends JsonValue = JsonValue>(namespace: string, options?: ListPrimitiveDbRecordsOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      const prefix = options?.prefix ?? "";
      yield* requireSafeDbKeyPrefix(prefix);
      const startAfter = yield* normalizeListStartAfter(options?.startAfter);
      const limit = yield* normalizeListLimit(options?.limit);
      const namespacePrefix = `${namespace}\0`;
      const matches = [...records.entries()]
        .filter(([key]) => key.startsWith(namespacePrefix))
        .map(([key, record]) => [key.slice(namespacePrefix.length), record] as const)
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => startAfter == null || compareUtf8Bytes(key, startAfter) > 0)
        .sort(([a], [b]) => compareUtf8Bytes(a, b));
      const page = matches.slice(0, limit);
      return {
        records: yield* Effect.all(page.map(([key, record]) => materializeRecord<A>(namespace, key, record))),
        ...(matches.length > limit ? { cursor: page[page.length - 1][0] } : {}),
      };
    });

  return { get, put, delete: deleteRecord, list };
}

/** Fails when a namespace would be unsafe across D1 and DynamoDB backends. */
export function requireSafeDbNamespace(namespace: string): Effect.Effect<void, PrimitiveDbError> {
  return safeDbNamespace(namespace)
    ? Effect.void
    : Effect.fail(new PrimitiveDbError({ message: `Invalid database namespace: ${namespace}` }));
}

/** Fails when a key would be unsafe across D1 and DynamoDB backends. */
export function requireSafeDbKey(key: string): Effect.Effect<void, PrimitiveDbError> {
  return safeDbKey(key)
    ? Effect.void
    : Effect.fail(new PrimitiveDbError({ message: `Invalid database key: ${key}` }));
}

/** Fails when a key prefix would be unsafe across D1 and DynamoDB backends. */
export function requireSafeDbKeyPrefix(prefix: string): Effect.Effect<void, PrimitiveDbError> {
  return safeDbKeyPrefix(prefix)
    ? Effect.void
    : Effect.fail(new PrimitiveDbError({ message: `Invalid database key prefix: ${prefix}` }));
}

/** Namespace syntax for logical record groups. */
export function safeDbNamespace(namespace: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(namespace);
}

/** Key syntax shared by all primitive DB backends. */
export function safeDbKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("\0") &&
    key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Prefix syntax for database list operations. Allows one trailing slash. */
export function safeDbKeyPrefix(prefix: string): boolean {
  if (prefix === "") return true;
  if (safeDbKey(prefix)) return true;
  return prefix.endsWith("/") && safeDbKey(prefix.slice(0, -1));
}

/** Encodes a JSON value without silently dropping unsupported JavaScript values. */
export function encodePrimitiveDbValue(value: JsonValue): Effect.Effect<string, PrimitiveDbError> {
  if (!isJsonValue(value)) {
    return Effect.fail(new PrimitiveDbError({ message: "Database value must be JSON-serializable" }));
  }
  return Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new PrimitiveDbError({ message: "Could not encode database value", cause }),
  });
}

/** Decodes a stored JSON value and validates the result. */
export function decodePrimitiveDbValue(text: string): Effect.Effect<JsonValue, PrimitiveDbError> {
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new PrimitiveDbError({ message: "Could not decode database value", cause }),
  }).pipe(
    Effect.flatMap((value) =>
      isJsonValue(value)
        ? Effect.succeed(value)
        : Effect.fail(new PrimitiveDbError({ message: "Stored database value is not valid JSON" })),
    ),
  );
}

/** Validates provider-independent write preconditions. */
export function validatePutOptions(options: PutPrimitiveDbRecordOptions | undefined): Effect.Effect<void, PrimitiveDbError> {
  if (options?.ifNoneMatch === "*" && options.ifMatch != null) {
    return Effect.fail(new PrimitiveDbError({ message: "Use only one database write precondition" }));
  }
  return validateVersionPrecondition(options?.ifMatch);
}

/** Validates provider-independent delete preconditions. */
export function validateDeleteOptions(options: DeletePrimitiveDbRecordOptions | undefined): Effect.Effect<void, PrimitiveDbError> {
  return validateVersionPrecondition(options?.ifMatch);
}

/** Validates the exclusive pagination cursor for provider implementations. */
export function normalizeListStartAfter(startAfter: string | undefined): Effect.Effect<string | undefined, PrimitiveDbError> {
  if (startAfter == null) return Effect.succeed(undefined);
  return safeDbKey(startAfter)
    ? Effect.succeed(startAfter)
    : Effect.fail(new PrimitiveDbError({ message: `Invalid database list cursor: ${startAfter}` }));
}

/** Normalizes and caps list limits for provider implementations. */
export function normalizeListLimit(limit: number | undefined): Effect.Effect<number, PrimitiveDbError> {
  if (limit == null) return Effect.succeed(100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return Effect.fail(new PrimitiveDbError({ message: "Database list limit must be an integer between 1 and 1000" }));
  }
  return Effect.succeed(limit);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value == null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function materializeRecord<A extends JsonValue>(
  namespace: string,
  key: string,
  record: MemoryRecord,
): Effect.Effect<PrimitiveDbRecord<A>, PrimitiveDbError> {
  return decodePrimitiveDbValue(record.encoded).pipe(
    Effect.map((value) => ({ namespace, key, value: value as A, version: record.version, updatedAt: record.updatedAt })),
  );
}

function memoryKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

const utf8Encoder = new TextEncoder();

function compareUtf8Bytes(a: string, b: string): number {
  const left = utf8Encoder.encode(a);
  const right = utf8Encoder.encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function validateVersionPrecondition(version: number | undefined): Effect.Effect<void, PrimitiveDbError> {
  if (version != null && (!Number.isInteger(version) || version < 1)) {
    return Effect.fail(new PrimitiveDbError({ message: "ifMatch must be a positive integer version" }));
  }
  return Effect.void;
}
