/*
 * Runs the invariant-6 conformance suites against the AWS adapters —
 * DynamoDbPrimitiveDb and S3ObjectStorage — pointed at LocalStack, with the
 * same bucket/table shapes the deploy tooling provisions. Honors the same
 * loud SCRATCHWORK_E2E_SKIP_AWS opt-out as the publish-loop lane (never
 * honored in CI).
 */
import { afterAll } from "bun:test";
import { CreateTableCommand, DynamoDBClient, UpdateTimeToLiveCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import * as Effect from "effect/Effect";
import { makeDynamoDbPrimitiveDb } from "@scratchwork/server-deploy-aws/dynamodb-db";
import { S3ObjectStorageLive } from "@scratchwork/server-deploy-aws/s3-storage";
import { ObjectStorage } from "@scratchwork/server-core/storage";
import { awsLaneSkipped, ensureLocalStack, type LocalStack } from "../src/localstack";
import { runPrimitiveDbConformance } from "../../server/core/test/conformance/primitive-db";
import { runObjectStorageConformance } from "../../server/core/test/conformance/object-storage";

const suffix = crypto.randomUUID().slice(0, 8);
const bucket = `scratchwork-conformance-${suffix}`;
const table = `scratchwork-conformance-${suffix}`;
const region = "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

let stack: LocalStack | null = null;

/** One LocalStack container (with bucket and table) shared by both suites. */
async function ensureStack(): Promise<LocalStack> {
  if (stack == null) {
    stack = await ensureLocalStack();
    // S3ObjectStorageLive builds its client from the given env record, but the
    // AWS SDK resolves credentials from the process environment.
    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    const dynamo = new DynamoDBClient({ region, endpoint: stack.endpoint, credentials });
    // The same table shape scripts/deploy.ts provisions in real AWS.
    await dynamo.send(new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [
        { AttributeName: "namespace", AttributeType: "S" },
        { AttributeName: "key", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "namespace", KeyType: "HASH" },
        { AttributeName: "key", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }));
    await waitUntilTableExists({ client: dynamo, maxWaitTime: 60 }, { TableName: table });
    await dynamo.send(new UpdateTimeToLiveCommand({
      TableName: table,
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    }));
    const { S3Client } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region, endpoint: stack.endpoint, credentials, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  return stack;
}

afterAll(async () => {
  await stack?.stop();
});

if (!awsLaneSkipped()) {
  runPrimitiveDbConformance({
    name: "dynamodb (localstack)",
    timeout: 120_000,
    makeDb: async () => {
      const localstack = await ensureStack();
      const client = new DynamoDBClient({ region, endpoint: localstack.endpoint, credentials });
      return makeDynamoDbPrimitiveDb(client, table);
    },
  });

  runObjectStorageConformance({
    name: "s3 (localstack)",
    timeout: 120_000,
    makeStorage: async () => {
      const localstack = await ensureStack();
      return Effect.runPromise(
        Effect.gen(function* () {
          return yield* ObjectStorage;
        }).pipe(
          Effect.provide(S3ObjectStorageLive({
            SCRATCHWORK_S3_BUCKET: bucket,
            SCRATCHWORK_S3_ENDPOINT: localstack.endpoint,
            SCRATCHWORK_S3_REGION: region,
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
          })),
        ),
      );
    },
  });
}
