#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const handlerPath = join(dist, "handler.mjs");
const zipPath = join(dist, "function.zip");
const trustPolicyPath = join(dist, "lambda-trust-policy.json");
const s3PolicyPath = join(dist, "s3-policy.json");
const environmentPath = join(dist, "environment.json");

const env = process.env;
const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? env.SCRATCHWORK_S3_REGION ?? "us-east-1";
const storageRegion = env.SCRATCHWORK_S3_REGION ?? region;
const functionName = env.SCRATCHWORK_AWS_FUNCTION_NAME ?? "scratchwork-server";
const roleName = env.SCRATCHWORK_AWS_ROLE_NAME ?? `${functionName}-lambda-role`;

await mkdir(dist, { recursive: true });
await run("bun", ["run", "build"], { cwd: root });
await rm(zipPath, { force: true });
await run("zip", ["-j", zipPath, handlerPath], { cwd: root });

const accountId = await awsText(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
const bucket = env.SCRATCHWORK_S3_BUCKET ?? `scratchwork-server-${accountId}-${storageRegion}`;

await ensureBucket(bucket, storageRegion);
const roleArn = await ensureRole(roleName, bucket);
await writeEnvironment(bucket, storageRegion);
await upsertFunction(functionName, roleArn);
const url = await ensureFunctionUrl(functionName);

console.log(`scratchwork AWS server deployed: ${url}`);
console.log(`publish with: scratchwork publish --server ${url}`);

async function ensureBucket(bucket: string, bucketRegion: string): Promise<void> {
  const exists = await aws(["s3api", "head-bucket", "--bucket", bucket], { allowFailure: true });
  if (exists.ok) return;

  const args = ["s3api", "create-bucket", "--bucket", bucket];
  if (bucketRegion !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${bucketRegion}`);
  }
  await aws(args);
}

async function ensureRole(role: string, bucket: string): Promise<string> {
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

async function writeEnvironment(bucket: string, bucketRegion: string): Promise<void> {
  const variables: Record<string, string> = {
    SCRATCHWORK_S3_BUCKET: bucket,
    SCRATCHWORK_S3_REGION: bucketRegion,
  };
  copyEnv(variables, "SCRATCHWORK_PUBLIC_URL");
  copyEnv(variables, "SCRATCHWORK_S3_ENDPOINT");
  copyEnv(variables, "SCRATCHWORK_S3_FORCE_PATH_STYLE");

  await writeFile(environmentPath, JSON.stringify({ Variables: variables }));
}

async function upsertFunction(name: string, roleArn: string): Promise<void> {
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

async function ensureFunctionUrl(name: string): Promise<string> {
  const existing = await awsText(
    ["lambda", "get-function-url-config", "--function-name", name, "--query", "FunctionUrl", "--output", "text"],
    { allowFailure: true },
  );
  if (existing) {
    await ensureFunctionUrlPermission(name);
    return existing;
  }

  await aws(["lambda", "create-function-url-config", "--function-name", name, "--auth-type", "NONE"]);
  await ensureFunctionUrlPermission(name);
  return awsText(["lambda", "get-function-url-config", "--function-name", name, "--query", "FunctionUrl", "--output", "text"]);
}

async function ensureFunctionUrlPermission(name: string): Promise<void> {
  await addPermission(
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
    name,
    "FunctionUrlAllowPublicInvoke",
    [
      "--action",
      "lambda:InvokeFunction",
      "--invoked-via-function-url",
    ],
  );
}

async function addPermission(
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

function copyEnv(target: Record<string, string>, key: string): void {
  const value = env[key];
  if (value != null && value !== "") target[key] = value;
}

async function awsText(args: ReadonlyArray<string>, options: RunOptions = {}): Promise<string> {
  const result = await aws(args, { ...options, capture: true });
  return result.ok ? result.stdout.trim() : "";
}

async function aws(args: ReadonlyArray<string>, options: RunOptions = {}): Promise<RunResult> {
  return run("aws", ["--region", region, ...args], options);
}

interface RunOptions {
  readonly allowFailure?: boolean;
  readonly capture?: boolean;
  readonly cwd?: string;
}

interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string, args: ReadonlyArray<string>, options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture || options.allowFailure ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout),
    read(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
  return { ok: exitCode === 0, stdout, stderr };
}

async function read(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (stream == null) return "";
  return new Response(stream).text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
