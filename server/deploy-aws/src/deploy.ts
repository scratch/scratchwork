import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definedEnv, loadDeployEnv, type DeployEnv } from "./deploy-env";
import { createRunner, type RunOptions, type RunResult } from "./deploy-proc";

export interface ScratchworkServerConfig {
  readonly publicUrl?: string;
  readonly auth?: "google";
  readonly googleClientId?: string;
  readonly authAllowedEmails?: string;
  readonly authAllowedDomains?: string;
  readonly authSessionSeconds?: number;
  readonly allowPublicPublish?: boolean;
}

export interface AwsDeployConfig {
  readonly region?: string;
  readonly storageRegion?: string;
  readonly functionName?: string;
  readonly roleName?: string;
  readonly s3Bucket?: string;
}

export interface AwsDeployServerConfig {
  readonly server?: ScratchworkServerConfig;
  readonly deploy?: AwsDeployConfig;
}

/** @deprecated Use AwsDeployServerConfig. */
export type AwsServerConfig = AwsDeployServerConfig;

export interface AwsDeployOptions {
  readonly envFile?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly processEnv?: DeployEnv;
  readonly loadPackageEnvFiles?: boolean;
}

export interface AwsDeployResult {
  readonly url: string;
  readonly functionName: string;
  readonly roleName: string;
  readonly roleArn: string;
  readonly bucketName: string;
  readonly region: string;
  readonly storageRegion: string;
}

interface ResolvedScratchworkServerConfig {
  readonly publicUrl?: string;
}

interface ResolvedAwsDeployConfig {
  readonly region: string;
  readonly storageRegion: string;
  readonly functionName: string;
  readonly roleName: string;
  readonly s3Bucket?: string;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const handlerPath = join(dist, "handler.mjs");
const zipPath = join(dist, "function.zip");
const trustPolicyPath = join(dist, "lambda-trust-policy.json");
const s3PolicyPath = join(dist, "s3-policy.json");
const environmentPath = join(dist, "environment.json");

/** Deploys the Scratchwork server as an AWS Lambda Function URL. */
export async function deployServer(
  config: AwsDeployServerConfig = {},
  options: AwsDeployOptions = {},
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
  const aws = (args: ReadonlyArray<string>, runOptions: RunOptions = {}) =>
    run("aws", ["--region", resolvedDeploy.region, ...args], runOptions);
  const awsText = async (args: ReadonlyArray<string>, runOptions: RunOptions = {}) => {
    const result = await aws(args, { ...runOptions, capture: true });
    return result.ok ? result.stdout.trim() : "";
  };

  await mkdir(dist, { recursive: true });
  validateDeploymentAuth(env);
  await run("bun", ["run", "build"], { cwd: root });
  await rm(zipPath, { force: true });
  await run("zip", ["-j", zipPath, handlerPath], { cwd: root });

  const accountId = await awsText(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
  const bucketName = resolvedDeploy.s3Bucket ?? `scratchwork-server-${accountId}-${resolvedDeploy.storageRegion}`;

  await ensureBucket(aws, bucketName, resolvedDeploy.storageRegion);
  const roleArn = await ensureRole(aws, awsText, resolvedDeploy.roleName, resolvedDeploy.functionName, bucketName);
  await writeEnvironment(env, bucketName, resolvedDeploy.storageRegion);
  await upsertFunction(aws, resolvedDeploy.functionName, roleArn);
  const url = await ensureFunctionUrl(aws, awsText, resolvedDeploy.functionName);

  return {
    url,
    functionName: resolvedDeploy.functionName,
    roleName: resolvedDeploy.roleName,
    roleArn,
    bucketName,
    region: resolvedDeploy.region,
    storageRegion: resolvedDeploy.storageRegion,
  };
}

function deployArgv(options: AwsDeployOptions): ReadonlyArray<string> {
  return options.envFile == null ? options.argv ?? [] : ["--env", options.envFile, ...(options.argv ?? [])];
}

function resolveServerConfig(config: ScratchworkServerConfig, env: DeployEnv): ResolvedScratchworkServerConfig {
  return {
    publicUrl: optional(config.publicUrl) ?? optional(env.SCRATCHWORK_PUBLIC_URL),
  };
}

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
  };
}

function serverConfigEnv(config: ScratchworkServerConfig, resolved: ResolvedScratchworkServerConfig): DeployEnv {
  const env: DeployEnv = {};
  if (config.auth != null) env.SCRATCHWORK_AUTH = config.auth;
  if (config.googleClientId != null) env.SCRATCHWORK_GOOGLE_CLIENT_ID = config.googleClientId;
  if (config.authAllowedEmails != null) env.SCRATCHWORK_AUTH_ALLOWED_EMAILS = config.authAllowedEmails;
  if (config.authAllowedDomains != null) env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS = config.authAllowedDomains;
  if (config.authSessionSeconds != null) env.SCRATCHWORK_AUTH_SESSION_SECONDS = String(config.authSessionSeconds);
  if (config.allowPublicPublish != null) env.SCRATCHWORK_ALLOW_PUBLIC_PUBLISH = config.allowPublicPublish ? "1" : "";
  if (resolved.publicUrl != null) env.SCRATCHWORK_PUBLIC_URL = resolved.publicUrl;
  return env;
}

function deployConfigEnv(resolved: ResolvedAwsDeployConfig): DeployEnv {
  const env: DeployEnv = {};
  env.AWS_REGION = resolved.region;
  env.SCRATCHWORK_S3_REGION = resolved.storageRegion;
  env.SCRATCHWORK_AWS_FUNCTION_NAME = resolved.functionName;
  env.SCRATCHWORK_AWS_ROLE_NAME = resolved.roleName;
  if (resolved.s3Bucket != null) env.SCRATCHWORK_S3_BUCKET = resolved.s3Bucket;
  return env;
}

/** Creates the S3 bucket when it does not already exist. */
async function ensureBucket(
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
  bucket: string,
  bucketRegion: string,
): Promise<void> {
  const exists = await aws(["s3api", "head-bucket", "--bucket", bucket], { allowFailure: true });
  if (exists.ok) return;

  const args = ["s3api", "create-bucket", "--bucket", bucket];
  if (bucketRegion !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${bucketRegion}`);
  }
  await aws(args);
}

/** Refuses accidental public deploys and validates required Google auth secrets. */
function validateDeploymentAuth(env: DeployEnv): void {
  if ((env.SCRATCHWORK_AUTH ?? "").toLowerCase() === "google") {
    for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
      if (!env[key]) throw new Error(`${key} is required when SCRATCHWORK_AUTH=google`);
    }
    return;
  }
  if (env.SCRATCHWORK_ALLOW_PUBLIC_PUBLISH === "1") return;
  throw new Error("AWS deploys require SCRATCHWORK_AUTH=google or explicit SCRATCHWORK_ALLOW_PUBLIC_PUBLISH=1");
}

/** Creates or updates the Lambda execution role and bucket access policy. */
async function ensureRole(
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
  awsText: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<string>,
  role: string,
  functionName: string,
  bucket: string,
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
    await sleep(10_000);
  }

  await writeFile(
    s3PolicyPath,
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: [`arn:aws:s3:::${bucket}/*`],
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
    `file://${s3PolicyPath}`,
  ]);

  return awsText(["iam", "get-role", "--role-name", role, "--query", "Role.Arn", "--output", "text"]);
}

/** Writes the Lambda environment JSON passed to AWS CLI. */
async function writeEnvironment(env: DeployEnv, bucket: string, bucketRegion: string): Promise<void> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("SCRATCHWORK_") && value != null && value !== "") variables[key] = value;
  }
  variables.SCRATCHWORK_S3_BUCKET = bucket;
  variables.SCRATCHWORK_S3_REGION = bucketRegion;

  await writeFile(environmentPath, JSON.stringify({ Variables: variables }));
}

/** Creates the Lambda or updates its code and configuration in place. */
async function upsertFunction(
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
  name: string,
  roleArn: string,
): Promise<void> {
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
async function ensureFunctionUrl(
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
  awsText: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<string>,
  name: string,
): Promise<string> {
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
async function ensureFunctionUrlPermission(
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
  name: string,
): Promise<void> {
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
  aws: (args: ReadonlyArray<string>, options?: RunOptions) => Promise<RunResult>,
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

/** Waits for IAM role propagation before creating the Lambda. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optional(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
