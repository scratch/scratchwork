#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const configPath = join(dist, "wrangler.jsonc");

const workerName = process.env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME ?? "scratchwork-server";
const bucketName = process.env.SCRATCHWORK_R2_BUCKET ?? "scratchwork-sites";
const publicUrl = process.env.SCRATCHWORK_PUBLIC_URL;
const compatibilityDate = process.env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE ?? "2026-06-01";

await mkdir(dist, { recursive: true });
await writeConfig();
await ensureBucket();
await run("wrangler", ["deploy", "--config", configPath], { cwd: root });

console.log(`scratchwork Cloudflare Worker deployed: ${workerName}`);
console.log("publish with: scratchwork publish --server https://<your-worker-domain>");

async function writeConfig(): Promise<void> {
  const vars = publicUrl == null || publicUrl === "" ? {} : { SCRATCHWORK_PUBLIC_URL: publicUrl };
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: workerName,
        main: "../src/worker.ts",
        compatibility_date: compatibilityDate,
        r2_buckets: [
          {
            binding: "SCRATCHWORK_R2",
            bucket_name: bucketName,
          },
        ],
        vars,
      },
      null,
      2,
    ),
  );
}

async function ensureBucket(): Promise<void> {
  if (process.env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE === "1") return;
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
