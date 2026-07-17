import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
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
  type PrimitiveDbRecord,
  type PrimitiveDbShape,
  type ListPrimitiveDbRecordsOptions,
  type PutPrimitiveDbRecordOptions,
} from "@scratchwork/server-core/db";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** DynamoDB client and table settings read from the deploy environment. */
export interface DynamoDbPrimitiveDbConfig {
  readonly tableName: string;
  readonly region: string;
  readonly endpoint?: string;
}

/** DynamoDB attribute names of the primitive-DB item shape. */
const NAMESPACE = "namespace";
const KEY = "key";
const VALUE = "value";
const VERSION = "version";
const UPDATED_AT = "updatedAt";
/** DynamoDB TTL attribute; deploy.ts enables native expiry for this field. */
const EXPIRES_AT = "expiresAt";

/** Reads DynamoDB table and client settings from deployment environment values. */
export function readDynamoDbPrimitiveDbConfig(
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<DynamoDbPrimitiveDbConfig, PrimitiveDbError> {
  const tableName = env.SCRATCHWORK_DYNAMODB_TABLE;
  if (!tableName) {
    return Effect.fail(new PrimitiveDbError({ message: "SCRATCHWORK_DYNAMODB_TABLE is required for AWS primitive DB" }));
  }
  if (!safeDynamoDbTableName(tableName)) {
    return Effect.fail(new PrimitiveDbError({ message: `Invalid DynamoDB table name: ${tableName}` }));
  }
  return Effect.succeed({
    tableName,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    endpoint: env.SCRATCHWORK_DYNAMODB_ENDPOINT,
  });
}

/** Adapts DynamoDB to the primitive DB contract using namespace + key as the primary key. */
export function DynamoDbPrimitiveDbLive(
  env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<PrimitiveDb, PrimitiveDbError> {
  return Layer.effect(
    PrimitiveDb,
    Effect.gen(function* () {
      const config = yield* readDynamoDbPrimitiveDbConfig(env);
      const client = new DynamoDBClient({ region: config.region, endpoint: config.endpoint });
      return PrimitiveDb.of(makeDynamoDbPrimitiveDb(client, config.tableName));
    }),
  );
}

/** Creates the primitive DB shape over an existing DynamoDB table. */
export function makeDynamoDbPrimitiveDb(client: DynamoDBClient, tableName: string): PrimitiveDbShape {
  if (!safeDynamoDbTableName(tableName)) {
    throw new PrimitiveDbError({ message: `Invalid DynamoDB table name: ${tableName}` });
  }

  const get: PrimitiveDbShape["get"] = <A extends JsonValue = JsonValue>(namespace: string, key: string) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      const response = yield* Effect.tryPromise({
        try: () => client.send(new GetItemCommand({ TableName: tableName, Key: keyAttributes(namespace, key) })),
        catch: (cause) => new PrimitiveDbError({ message: `Could not read DynamoDB record: ${namespace}/${key}`, cause }),
      });
      return response.Item == null || itemExpired(response.Item) ? null : yield* itemToRecord<A>(response.Item);
    });

  const put: PrimitiveDbShape["put"] = <A extends JsonValue = JsonValue>(namespace: string, key: string, value: A, options?: PutPrimitiveDbRecordOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      yield* validatePutOptions(options);
      const encoded = yield* encodePrimitiveDbValue(value);
      const updatedAt = new Date().toISOString();

      if (options?.ifNoneMatch === "*") {
        yield* Effect.tryPromise({
          try: () => client.send(new PutItemCommand({
            TableName: tableName,
            Item: itemAttributes(namespace, key, encoded, 1, updatedAt, options.expiresAt),
            ConditionExpression: "attribute_not_exists(#namespace) OR #expiresAt <= :now",
            ExpressionAttributeNames: { "#namespace": NAMESPACE, "#expiresAt": EXPIRES_AT },
            ExpressionAttributeValues: { ":now": { N: String(epochSeconds()) } },
          })),
          catch: (cause) => toDynamoDbWriteError(cause, namespace, key),
        });
        return yield* itemToRecord<A>(itemAttributes(namespace, key, encoded, 1, updatedAt, options.expiresAt));
      }

      const expressionAttributeNames = {
        "#value": VALUE,
        "#version": VERSION,
        "#updatedAt": UPDATED_AT,
        "#expiresAt": EXPIRES_AT,
      };
      const expressionAttributeValues: Record<string, AttributeValue> = {
        ":value": { S: encoded },
        ":updatedAt": { S: updatedAt },
        ":zero": { N: "0" },
        ":one": { N: "1" },
      };
      const conditionExpression = options?.ifMatch == null ? undefined : "#version = :expected";
      if (options?.ifMatch != null) expressionAttributeValues[":expected"] = { N: String(options.ifMatch) };
      if (options?.expiresAt != null) expressionAttributeValues[":expiresAt"] = { N: String(options.expiresAt) };

      const response = yield* Effect.tryPromise({
        try: () => client.send(new UpdateItemCommand({
          TableName: tableName,
          Key: keyAttributes(namespace, key),
          UpdateExpression: options?.expiresAt == null
            ? "SET #value = :value, #updatedAt = :updatedAt, #version = if_not_exists(#version, :zero) + :one REMOVE #expiresAt"
            : "SET #value = :value, #updatedAt = :updatedAt, #version = if_not_exists(#version, :zero) + :one, #expiresAt = :expiresAt",
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: "ALL_NEW",
        })),
        catch: (cause) => toDynamoDbWriteError(cause, namespace, key),
      });
      if (response.Attributes == null) {
        return yield* Effect.fail(new PrimitiveDbError({ message: `DynamoDB did not return record: ${namespace}/${key}` }));
      }
      return yield* itemToRecord<A>(response.Attributes);
    });

  const deleteRecord: PrimitiveDbShape["delete"] = (namespace: string, key: string, options?: DeletePrimitiveDbRecordOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      yield* requireSafeDbKey(key);
      yield* validateDeleteOptions(options);
      yield* Effect.tryPromise({
        try: () => client.send(new DeleteItemCommand({
          TableName: tableName,
          Key: keyAttributes(namespace, key),
          ConditionExpression: options?.ifMatch == null ? undefined : "#version = :expected",
          ExpressionAttributeNames: options?.ifMatch == null ? undefined : { "#version": VERSION },
          ExpressionAttributeValues: options?.ifMatch == null ? undefined : { ":expected": { N: String(options.ifMatch) } },
        })),
        catch: (cause) => toDynamoDbWriteError(cause, namespace, key),
      });
    });

  const list: PrimitiveDbShape["list"] = <A extends JsonValue = JsonValue>(namespace: string, options?: ListPrimitiveDbRecordsOptions) =>
    Effect.gen(function* () {
      yield* requireSafeDbNamespace(namespace);
      const prefix = options?.prefix ?? "";
      yield* requireSafeDbKeyPrefix(prefix);
      const startAfter = yield* normalizeListStartAfter(options?.startAfter);
      const limit = yield* normalizeListLimit(options?.limit);
      const response = yield* Effect.tryPromise({
        try: () => client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: prefix === "" ? "#namespace = :namespace" : "#namespace = :namespace AND begins_with(#key, :prefix)",
          // DynamoDB rejects attribute names that no expression uses, so #key
          // may appear only when the prefix condition does.
          ExpressionAttributeNames: prefix === "" ? { "#namespace": NAMESPACE } : { "#namespace": NAMESPACE, "#key": KEY },
          ExpressionAttributeValues: prefix === "" ? { ":namespace": { S: namespace } } : { ":namespace": { S: namespace }, ":prefix": { S: prefix } },
          Limit: limit,
          ScanIndexForward: true,
          ExclusiveStartKey: startAfter == null ? undefined : keyAttributes(namespace, startAfter),
        })),
        catch: (cause) => new PrimitiveDbError({ message: `Could not list DynamoDB records: ${namespace}`, cause }),
      });
      const lastEvaluatedKey = response.LastEvaluatedKey?.[KEY]?.S;
      return {
        records: yield* Effect.all((response.Items ?? []).filter((item) => !itemExpired(item)).map((item) => itemToRecord<A>(item))),
        ...(lastEvaluatedKey == null ? {} : { cursor: lastEvaluatedKey }),
      };
    });

  return { get, put, delete: deleteRecord, list };
}

/** Builds the DynamoDB primary-key attributes for one record. */
function keyAttributes(namespace: string, key: string): Record<string, AttributeValue> {
  return { [NAMESPACE]: { S: namespace }, [KEY]: { S: key } };
}

/** Builds the full DynamoDB item for one record. */
function itemAttributes(
  namespace: string,
  key: string,
  value: string,
  version: number,
  updatedAt: string,
  expiresAt?: number,
): Record<string, AttributeValue> {
  return {
    ...keyAttributes(namespace, key),
    [VALUE]: { S: value },
    [VERSION]: { N: String(version) },
    [UPDATED_AT]: { S: updatedAt },
    ...(expiresAt == null ? {} : { [EXPIRES_AT]: { N: String(expiresAt) } }),
  };
}

/** Treats elapsed TTL records as absent even before DynamoDB's asynchronous sweeper
 * physically removes them. */
function itemExpired(item: Record<string, AttributeValue>): boolean {
  const expiresAt = Number(item[EXPIRES_AT]?.N);
  return Number.isFinite(expiresAt) && expiresAt <= epochSeconds();
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Converts a DynamoDB item back into the public record shape. */
function itemToRecord<A extends JsonValue>(item: Record<string, AttributeValue>): Effect.Effect<PrimitiveDbRecord<A>, PrimitiveDbError> {
  const namespace = item[NAMESPACE]?.S;
  const key = item[KEY]?.S;
  const value = item[VALUE]?.S;
  const version = Number(item[VERSION]?.N);
  const updatedAt = item[UPDATED_AT]?.S;
  if (!namespace || !key || value == null || !Number.isInteger(version) || version < 1 || !updatedAt) {
    return Effect.fail(new PrimitiveDbError({ message: "DynamoDB item does not match primitive DB shape" }));
  }
  return decodePrimitiveDbValue(value).pipe(
    Effect.map((decoded) => ({ namespace, key, value: decoded as A, version, updatedAt })),
  );
}

/** Maps write failures onto conflict vs generic DB errors. */
function toDynamoDbWriteError(cause: unknown, namespace: string, key: string): PrimitiveDbError | PrimitiveDbConflict {
  return isConditionalCheckFailed(cause)
    ? new PrimitiveDbConflict({ namespace, key, message: `Record write precondition failed: ${namespace}/${key}` })
    : new PrimitiveDbError({ message: `Could not write DynamoDB record: ${namespace}/${key}`, cause });
}

/** Detects DynamoDB conditional-check failures across SDK exception shapes. */
function isConditionalCheckFailed(cause: unknown): boolean {
  if (cause instanceof ConditionalCheckFailedException) return true;
  return (cause as { readonly name?: string }).name === "ConditionalCheckFailedException";
}

/** Returns true for a valid DynamoDB table name. */
function safeDynamoDbTableName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{3,255}$/.test(name);
}
