/*
 * AWS backend lane: the real Lambda handler (event adaptation included) with the
 * real S3/DynamoDB adapters pointed at LocalStack. An HTTP shim translates each
 * request into an API Gateway v2 event and the handler's structured result back
 * into a response, standing in for the Function URL front door.
 *
 * Requires SCRATCHWORK_E2E_LOCALSTACK (the LocalStack edge endpoint); the test
 * harness starts or reuses the container. Creates the bucket and table (the
 * same shapes deploy.ts provisions), then serves on PORT and prints the shared
 * `app      <url>` ready banner.
 */
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const localstack = process.env.SCRATCHWORK_E2E_LOCALSTACK;
const port = Number(process.env.PORT);
if (localstack == null || localstack === "" || !Number.isInteger(port) || port <= 0) {
  console.error("aws lane requires SCRATCHWORK_E2E_LOCALSTACK and PORT");
  process.exit(1);
}

const suffix = crypto.randomUUID().slice(0, 8);
const bucket = `scratchwork-e2e-${suffix}`;
const table = `scratchwork-e2e-${suffix}`;
const region = "us-east-1";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

// The handler builds its service graph from process.env on first invocation.
process.env.AWS_REGION = region;
process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
process.env.SCRATCHWORK_S3_BUCKET = bucket;
process.env.SCRATCHWORK_S3_ENDPOINT = localstack;
process.env.SCRATCHWORK_DYNAMODB_TABLE = table;
process.env.SCRATCHWORK_DYNAMODB_ENDPOINT = localstack;

const s3 = new S3Client({ region, endpoint: localstack, credentials, forcePathStyle: true });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const dynamo = new DynamoDBClient({ region, endpoint: localstack, credentials });
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

const { handler } = await import("@scratchwork/server-deploy-aws/handler");

/** Translates one Web request into the API Gateway v2 event shape. */
async function requestToEvent(request: Request): Promise<APIGatewayProxyEventV2> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (key !== "cookie") headers[key] = value;
  }
  // The Function URL sits behind HTTPS in production; locally the shim is the
  // edge, so it reports the plain-http public origin it serves.
  headers["x-forwarded-proto"] = "http";
  const bodyBytes = request.method === "GET" || request.method === "HEAD"
    ? null
    : Buffer.from(await request.arrayBuffer());
  const cookieHeader = request.headers.get("cookie");
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    cookies: cookieHeader == null ? undefined : cookieHeader.split("; "),
    headers,
    requestContext: {
      accountId: "anonymous",
      apiId: "e2e",
      domainName: url.host,
      domainPrefix: "e2e",
      http: {
        method: request.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: request.headers.get("user-agent") ?? "e2e",
      },
      requestId: crypto.randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: bodyBytes == null || bodyBytes.length === 0 ? undefined : bodyBytes.toString("base64"),
    isBase64Encoded: bodyBytes != null && bodyBytes.length > 0,
  } as APIGatewayProxyEventV2;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const event = await requestToEvent(request);
    const result = await handler(event, {} as never);
    const headers = new Headers(result.headers as Record<string, string> | undefined);
    for (const cookie of result.cookies ?? []) {
      headers.append("set-cookie", cookie);
    }
    const body = result.body == null
      ? null
      : result.isBase64Encoded
        ? Buffer.from(result.body, "base64")
        : result.body;
    return new Response(body, { status: result.statusCode ?? 200, headers });
  },
});

console.log("scratchwork e2e aws (localstack)");
console.log(`app      ${process.env.SCRATCHWORK_APP_URL}`);
console.log(`content  ${process.env.SCRATCHWORK_CONTENT_URL}`);
