/**
 * Deploys the Scratchwork server to AWS Lambda + S3 + DynamoDB by shelling out to the
 * `aws` CLI. Like all deploy tooling under server/, this is deliberately plain
 * Promise-based script code, not Effect: it runs once on a developer's machine.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definedEnv, loadDeployEnv, type DeployEnv } from "@scratchwork/server-core/deploy/env";
import { createRunner, type RunOptions, type RunResult } from "@scratchwork/server-core/deploy/proc";
import {
  deployArgv,
  homepagePublishHint,
  optional,
  resolveServerConfig,
  serverConfigEnv,
  validateDeploymentConfig,
  type DeployServerOptions,
  type ScratchworkServerConfig,
} from "@scratchwork/server-core/deploy/server-settings";

/** Deploy options and server settings, shared with the other deploy packages. */
export type { DeployServerOptions as AwsDeployOptions, ScratchworkServerConfig };

/** AWS-specific deploy settings; unset values fall back to env vars and defaults. */
export interface AwsDeployConfig {
  readonly region?: string;
  readonly storageRegion?: string;
  readonly functionName?: string;
  readonly roleName?: string;
  readonly s3Bucket?: string;
  readonly dynamoDbTable?: string;
}

/** A deploy project's full config: server settings plus AWS deploy settings. */
export interface AwsDeployServerConfig {
  readonly server?: ScratchworkServerConfig;
  readonly deploy?: AwsDeployConfig;
}

/** What deployServer reports back after a successful deploy. */
export interface AwsDeployResult {
  readonly url: string;
  readonly functionName: string;
  readonly roleName: string;
  readonly roleArn: string;
  readonly bucketName: string;
  readonly dynamoDbTable: string;
  readonly region: string;
  readonly storageRegion: string;
}

/** AwsDeployConfig with every fallback applied. */
interface ResolvedAwsDeployConfig {
  readonly region: string;
  readonly storageRegion: string;
  readonly functionName: string;
  readonly roleName: string;
  readonly s3Bucket?: string;
  readonly dynamoDbTable?: string;
}

/** Runs one `aws` CLI command in the deploy region. */
type Aws = (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>;
/** Runs one `aws` CLI command and returns its trimmed stdout ("" on failure). */
type AwsText = (args: ReadonlyArray<string>, options?: RunOptions) => Promise<string>;

/** Build artifacts written under dist/ for the AWS CLI to consume. */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const handlerPath = join(dist, "handler.mjs");
const zipPath = join(dist, "function.zip");
const trustPolicyPath = join(dist, "lambda-trust-policy.json");
const accessPolicyPath = join(dist, "s3-policy.json");
const environmentPath = join(dist, "environment.json");

/** Deploys the Scratchwork server as an AWS Lambda Function URL. */
export async function deployServer(
  config: AwsDeployServerConfig = {},
  options: DeployServerOptions = {},
): Promise<AwsDeployResult> {
  const loadedEnv = await loadDeployEnv({
    packageRoot: root,
    argv: deployArgv(options),
    processEnv: options.processEnv ?? process.env,
    loadDefaultEnvFiles: options.loadPackageEnvFiles === true,
    explicitEnvRoots: options.loadPackageEnvFiles === true ? undefined : [process.cwd()],
  });
  const serverConfig = config.server ?? {};
  const deployConfig = config.deploy ?? {};
  const resolvedServer = resolveServerConfig(serverConfig, loadedEnv.env);
  const resolvedDeploy = resolveDeployConfig(deployConfig, loadedEnv.env);
  const env = {
    ...loadedEnv.env,
    ...serverConfigEnv(serverConfig, resolvedServer),
    ...deployConfigEnv(resolvedDeploy),
  };
  const commandEnv = definedEnv(env);
  const { run } = createRunner(commandEnv);
  const aws: Aws = (args, runOptions = {}) =>
    run("aws", ["--region", resolvedDeploy.region, ...args], runOptions);
  const awsText: AwsText = async (args, runOptions = {}) => {
    const result = await aws(args, { ...runOptions, capture: true });
    return result.ok ? result.stdout.trim() : "";
  };

  await mkdir(dist, { recursive: true });
  validateDeploymentConfig(env);
  await run("bun", ["run", "build"], { cwd: root });
  await rm(zipPath, { force: true });
  await run("zip", ["-j", zipPath, handlerPath], { cwd: root });

  const accountId = await awsText(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
  const bucketName = resolvedDeploy.s3Bucket ?? `scratchwork-server-${accountId}-${resolvedDeploy.storageRegion}`;
  const tableName = resolvedDeploy.dynamoDbTable ?? `${resolvedDeploy.functionName}-projects`;

  await ensureBucket(aws, bucketName, resolvedDeploy.storageRegion);
  await ensureDynamoDbTable(aws, tableName);
  const roleArn = await ensureRole(aws, awsText, resolvedDeploy.roleName, resolvedDeploy.functionName, bucketName, tableName, resolvedDeploy.region);
  await writeEnvironment(env, bucketName, resolvedDeploy.storageRegion, tableName);
  await upsertFunction(aws, resolvedDeploy.functionName, roleArn);
  const url = await ensureFunctionUrl(aws, awsText, resolvedDeploy.functionName);

  const homepageHint = homepagePublishHint(serverConfig, resolvedServer);
  if (homepageHint != null) console.log(homepageHint);

  return {
    url,
    functionName: resolvedDeploy.functionName,
    roleName: resolvedDeploy.roleName,
    roleArn,
    bucketName,
    dynamoDbTable: tableName,
    region: resolvedDeploy.region,
    storageRegion: resolvedDeploy.storageRegion,
  };
}

/** Applies env-var and default fallbacks to the AWS deploy settings. */
function resolveDeployConfig(config: AwsDeployConfig, env: DeployEnv): ResolvedAwsDeployConfig {
  const region = optional(config.region)
    ?? optional(env.AWS_REGION)
    ?? optional(env.AWS_DEFAULT_REGION)
    ?? optional(env.SCRATCHWORK_S3_REGION)
    ?? "us-east-1";
  const storageRegion = optional(config.storageRegion) ?? optional(env.SCRATCHWORK_S3_REGION) ?? region;
  const functionName = optional(config.functionName) ?? optional(env.SCRATCHWORK_AWS_FUNCTION_NAME) ?? "scratchwork-server";
  return {
    region,
    storageRegion,
    functionName,
    roleName: optional(config.roleName) ?? optional(env.SCRATCHWORK_AWS_ROLE_NAME) ?? `${functionName}-lambda-role`,
    s3Bucket: optional(config.s3Bucket) ?? optional(env.SCRATCHWORK_S3_BUCKET),
    dynamoDbTable: optional(config.dynamoDbTable) ?? optional(env.SCRATCHWORK_DYNAMODB_TABLE),
  };
}

/** Maps resolved AWS deploy settings back onto their environment variables. */
function deployConfigEnv(resolved: ResolvedAwsDeployConfig): DeployEnv {
  const env: DeployEnv = {};
  env.AWS_REGION = resolved.region;
  env.SCRATCHWORK_S3_REGION = resolved.storageRegion;
  env.SCRATCHWORK_AWS_FUNCTION_NAME = resolved.functionName;
  env.SCRATCHWORK_AWS_ROLE_NAME = resolved.roleName;
  if (resolved.s3Bucket != null) env.SCRATCHWORK_S3_BUCKET = resolved.s3Bucket;
  if (resolved.dynamoDbTable != null) env.SCRATCHWORK_DYNAMODB_TABLE = resolved.dynamoDbTable;
  return env;
}

/** Creates the S3 bucket when it does not already exist. */
async function ensureBucket(aws: Aws, bucket: string, bucketRegion: string): Promise<void> {
  const exists = await aws(["s3api", "head-bucket", "--bucket", bucket], { allowFailure: true });
  if (exists.ok) return;

  const args = ["s3api", "create-bucket", "--bucket", bucket];
  if (bucketRegion !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${bucketRegion}`);
  }
  await aws(args);
}

/** Creates the DynamoDB primitive DB table when it does not already exist. */
async function ensureDynamoDbTable(aws: Aws, table: string): Promise<void> {
  const exists = await aws(["dynamodb", "describe-table", "--table-name", table], { allowFailure: true });
  if (!exists.ok) {
    await aws([
      "dynamodb",
      "create-table",
      "--table-name",
      table,
      "--attribute-definitions",
      "AttributeName=namespace,AttributeType=S",
      "AttributeName=key,AttributeType=S",
      "--key-schema",
      "AttributeName=namespace,KeyType=HASH",
      "AttributeName=key,KeyType=RANGE",
      "--billing-mode",
      "PAY_PER_REQUEST",
    ]);
    await aws(["dynamodb", "wait", "table-exists", "--table-name", table]);
  }

  const ttl = await aws([
    "dynamodb", "describe-time-to-live", "--table-name", table,
    "--query", "TimeToLiveDescription.TimeToLiveStatus", "--output", "text",
  ], { allowFailure: true, capture: true });
  if (!ttl.ok || !["ENABLED", "ENABLING"].includes(ttl.stdout.trim())) {
    await aws([
      "dynamodb", "update-time-to-live", "--table-name", table,
      "--time-to-live-specification", "Enabled=true,AttributeName=expiresAt",
    ]);
  }
}

/** Creates or updates the Lambda execution role and its S3 + DynamoDB access policy. */
async function ensureRole(
  aws: Aws,
  awsText: AwsText,
  role: string,
  functionName: string,
  bucket: string,
  table: string,
  region: string,
): Promise<string> {
  const roleExists = await aws(["iam", "get-role", "--role-name", role], { allowFailure: true });
  if (!roleExists.ok) {
    await writeFile(
      trustPolicyPath,
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    );
    await aws([
      "iam",
      "create-role",
      "--role-name",
      role,
      "--assume-role-policy-document",
      `file://${trustPolicyPath}`,
    ]);
    await aws([
      "iam",
      "attach-role-policy",
      "--role-name",
      role,
      "--policy-arn",
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ]);
    // Wait for IAM role propagation before the Lambda references the new role.
    await sleep(10_000);
  }

  await writeFile(
    accessPolicyPath,
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
          Resource: [`arn:aws:dynamodb:${region}:*:table/${table}`],
        },
      ],
    }),
  );
  await aws([
    "iam",
    "put-role-policy",
    "--role-name",
    role,
    "--policy-name",
    `${functionName}-s3-access`,
    "--policy-document",
    `file://${accessPolicyPath}`,
  ]);

  return awsText(["iam", "get-role", "--role-name", role, "--query", "Role.Arn", "--output", "text"]);
}

/** Writes the Lambda environment JSON passed to AWS CLI. */
async function writeEnvironment(env: DeployEnv, bucket: string, bucketRegion: string, table: string): Promise<void> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("SCRATCHWORK_") && value != null && value !== "") variables[key] = value;
  }
  variables.SCRATCHWORK_S3_BUCKET = bucket;
  variables.SCRATCHWORK_S3_REGION = bucketRegion;
  variables.SCRATCHWORK_DYNAMODB_TABLE = table;

  await writeFile(environmentPath, JSON.stringify({ Variables: variables }));
}

/** Creates the Lambda or updates its code and configuration in place. */
async function upsertFunction(aws: Aws, name: string, roleArn: string): Promise<void> {
  const exists = await aws(["lambda", "get-function", "--function-name", name], { allowFailure: true });
  if (exists.ok) {
    await aws([
      "lambda",
      "update-function-code",
      "--function-name",
      name,
      "--zip-file",
      `fileb://${zipPath}`,
    ]);
    await aws(["lambda", "wait", "function-updated", "--function-name", name]);
    await aws([
      "lambda",
      "update-function-configuration",
      "--function-name",
      name,
      "--role",
      roleArn,
      "--timeout",
      "30",
      "--memory-size",
      "512",
      "--environment",
      `file://${environmentPath}`,
    ]);
    await aws(["lambda", "wait", "function-updated", "--function-name", name]);
    return;
  }

  await aws([
    "lambda",
    "create-function",
    "--function-name",
    name,
    "--runtime",
    "nodejs20.x",
    "--handler",
    "handler.handler",
    "--role",
    roleArn,
    "--zip-file",
    `fileb://${zipPath}`,
    "--timeout",
    "30",
    "--memory-size",
    "512",
    "--environment",
    `file://${environmentPath}`,
  ]);
  await aws(["lambda", "wait", "function-active", "--function-name", name]);
}

/** Creates or returns the public Lambda Function URL. */
async function ensureFunctionUrl(aws: Aws, awsText: AwsText, name: string): Promise<string> {
  const existing = await awsText(
    ["lambda", "get-function-url-config", "--function-name", name, "--query", "FunctionUrl", "--output", "text"],
    { allowFailure: true },
  );
  if (existing) {
    await ensureFunctionUrlPermission(aws, name);
    return existing;
  }

  await aws(["lambda", "create-function-url-config", "--function-name", name, "--auth-type", "NONE"]);
  await ensureFunctionUrlPermission(aws, name);
  return awsText(["lambda", "get-function-url-config", "--function-name", name, "--query", "FunctionUrl", "--output", "text"]);
}

/** Ensures public invoke permissions exist for the Function URL. */
async function ensureFunctionUrlPermission(aws: Aws, name: string): Promise<void> {
  await addPermission(
    aws,
    name,
    "FunctionUrlAllowPublicAccess",
    [
      "--action",
      "lambda:InvokeFunctionUrl",
      "--function-url-auth-type",
      "NONE",
    ],
  );
  await addPermission(
    aws,
    name,
    "FunctionUrlAllowPublicInvoke",
    [
      "--action",
      "lambda:InvokeFunction",
      "--invoked-via-function-url",
    ],
  );
}

/** Adds one Lambda permission statement, ignoring already-existing statements. */
async function addPermission(
  aws: Aws,
  name: string,
  statementId: string,
  args: ReadonlyArray<string>,
): Promise<void> {
  const result = await aws(
    [
      "lambda",
      "add-permission",
      "--function-name",
      name,
      "--statement-id",
      statementId,
      "--principal",
      "*",
      ...args,
    ],
    { allowFailure: true, capture: true },
  );
  if (result.ok || result.stderr.includes("ResourceConflictException")) return;
  process.stderr.write(result.stderr || result.stdout);
  throw new Error(`Could not add Lambda Function URL permission ${statementId}`);
}

/** Resolves after the given delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
