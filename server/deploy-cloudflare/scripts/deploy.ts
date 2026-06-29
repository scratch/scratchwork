#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyEnv, definedEnv, loadDeployEnv } from "../../scripts/env";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const workerPath = join(dist, "worker.js");
const configPath = join(dist, "wrangler.jsonc");

const loadedEnv = await loadDeployEnv({ packageRoot: root, argv: Bun.argv.slice(2), processEnv: process.env });
const env = loadedEnv.env;
const commandEnv = definedEnv(env);
const workerName = env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME ?? "scratchwork-server";
const bucketName = env.SCRATCHWORK_R2_BUCKET ?? "scratchwork-sites";
const customDomain = env.SCRATCHWORK_CLOUDFLARE_CUSTOM_DOMAIN;
const route = env.SCRATCHWORK_CLOUDFLARE_ROUTE;
const zoneName = env.SCRATCHWORK_CLOUDFLARE_ZONE_NAME;
const publicUrl = env.SCRATCHWORK_PUBLIC_URL ?? (customDomain == null || customDomain === "" ? undefined : `https://${customDomain}`);
const compatibilityDate = env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE ?? "2026-06-01";

await mkdir(dist, { recursive: true });
validateAuthEnv();
await buildWorker();
await writeConfig();
await ensureBucket();
await run("wrangler", ["deploy", "--config", configPath, "--no-bundle"], { cwd: root });
await putSecret("SCRATCHWORK_GOOGLE_CLIENT_SECRET");
await putSecret("SCRATCHWORK_SESSION_SECRET");

console.log(`scratchwork Cloudflare Worker deployed: ${workerName}`);
console.log("publish with: scratchwork publish --server https://<your-worker-domain>");

async function writeConfig(): Promise<void> {
  const vars: Record<string, string> = {};
  copyEnv(vars, env, "SCRATCHWORK_AUTH");
  copyEnv(vars, env, "SCRATCHWORK_GOOGLE_CLIENT_ID");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_EMAILS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_SESSION_SECONDS");
  if (publicUrl != null && publicUrl !== "") vars.SCRATCHWORK_PUBLIC_URL = publicUrl;
  const routes = cloudflareRoutes();
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: workerName,
        main: "worker.js",
        compatibility_date: compatibilityDate,
        r2_buckets: [
          {
            binding: "SCRATCHWORK_R2",
            bucket_name: bucketName,
          },
        ],
        ...(routes.length === 0 ? {} : { routes }),
        vars,
      },
      null,
      2,
    ),
  );
}

async function buildWorker(): Promise<void> {
  await run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${workerPath}`], { cwd: root });
}

function cloudflareRoutes(): ReadonlyArray<Record<string, string | boolean>> {
  const routes: Array<Record<string, string | boolean>> = [];
  if (customDomain != null && customDomain !== "") {
    routes.push({ pattern: customDomain, custom_domain: true, ...zoneFor(customDomain) });
  }
  if (route != null && route !== "") {
    routes.push({ pattern: route, ...zoneFor(route) });
  }
  return routes;
}

function zoneFor(pattern: string): Record<string, string> {
  const configured = zoneName?.trim();
  if (configured) return { zone_name: configured };
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? { zone_name: labels.slice(-2).join(".") } : {};
}

function validateAuthEnv(): void {
  if ((env.SCRATCHWORK_AUTH ?? "").toLowerCase() !== "google") return;
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) throw new Error(`${key} is required when SCRATCHWORK_AUTH=google`);
  }
}

async function putSecret(key: string): Promise<void> {
  const value = env[key];
  if (value == null || value === "") return;
  const proc = Bun.spawn(["wrangler", "secret", "put", key, "--config", configPath], {
    cwd: root,
    env: commandEnv,
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  proc.stdin.write(value);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`wrangler secret put ${key} failed with exit code ${exitCode}`);
}

async function ensureBucket(): Promise<void> {
  if (env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE === "1") return;
  const result = await run("wrangler", ["r2", "bucket", "create", bucketName], {
    allowFailure: true,
    capture: true,
    cwd: root,
  });
  if (result.ok || alreadyExists(result.stderr) || alreadyExists(result.stdout)) return;
  process.stderr.write(result.stderr || result.stdout);
  throw new Error(`Could not create R2 bucket ${bucketName}`);
}

function alreadyExists(value: string): boolean {
  return value.toLowerCase().includes("already exists");
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
    env: commandEnv,
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
