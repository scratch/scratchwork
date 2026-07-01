import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyEnv, definedEnv, loadDeployEnv, type DeployEnv } from "./deploy-env";
import { createRunner } from "./deploy-proc";

export interface CloudflareR2BucketConfig {
  readonly name: string;
  readonly binding?: "SCRATCHWORK_R2";
}

export interface CloudflareRouteConfig {
  readonly pattern: string;
  readonly zoneName?: string;
  readonly customDomain?: boolean;
}

export interface CloudflareServerConfig {
  readonly publicUrl?: string;
  readonly auth?: "google";
  readonly googleClientId?: string;
  readonly authAllowedEmails?: string;
  readonly authAllowedDomains?: string;
  readonly authSessionSeconds?: number;
  readonly allowPublicPublish?: boolean;
  readonly workerName?: string;
  readonly compatibilityDate?: string;
  readonly r2Bucket?: string | CloudflareR2BucketConfig;
  readonly route?: string;
  readonly customDomain?: string;
  readonly zoneName?: string;
  readonly routes?: ReadonlyArray<CloudflareRouteConfig>;
  readonly skipBucketCreate?: boolean;
}

export interface CloudflareDeployOptions {
  readonly envFile?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly processEnv?: DeployEnv;
  readonly loadPackageEnvFiles?: boolean;
}

export interface CloudflareDeployResult {
  readonly workerName: string;
  readonly bucketName: string;
  readonly publicUrl?: string;
  readonly routes: ReadonlyArray<Record<string, string | boolean>>;
  readonly configPath: string;
  readonly workerPath: string;
}

interface ResolvedCloudflareServerConfig {
  readonly publicUrl?: string;
  readonly workerName: string;
  readonly compatibilityDate: string;
  readonly bucketName: string;
  readonly bucketBinding: "SCRATCHWORK_R2";
  readonly route?: string;
  readonly customDomain?: string;
  readonly zoneName?: string;
  readonly routes?: ReadonlyArray<CloudflareRouteConfig>;
  readonly skipBucketCreate: boolean;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const workerPath = join(dist, "worker.js");
const configPath = join(dist, "wrangler.jsonc");

/** Deploys the Scratchwork server as a Cloudflare Worker. */
export async function deployServer(
  config: CloudflareServerConfig = {},
  options: CloudflareDeployOptions = {},
): Promise<CloudflareDeployResult> {
  const loadedEnv = await loadDeployEnv({
    packageRoot: root,
    argv: deployArgv(options),
    processEnv: options.processEnv ?? process.env,
    loadDefaultEnvFiles: options.loadPackageEnvFiles === true,
    explicitEnvRoots: options.loadPackageEnvFiles === true ? undefined : [process.cwd()],
  });
  const resolved = resolveConfig(config, loadedEnv.env);
  const env = { ...loadedEnv.env, ...configEnv(config, resolved) };
  const commandEnv = definedEnv(env);
  const { run } = createRunner(commandEnv);

  await mkdir(dist, { recursive: true });
  validateDeploymentAuth(env);
  await run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${workerPath}`], { cwd: root });
  const routes = cloudflareRoutes(resolved);
  await writeConfig(resolved, env, routes);
  await ensureBucket(resolved, run);
  await run("wrangler", ["deploy", "--config", configPath, "--no-bundle"], { cwd: root });
  await putSecret(commandEnv, env, "SCRATCHWORK_GOOGLE_CLIENT_SECRET");
  await putSecret(commandEnv, env, "SCRATCHWORK_SESSION_SECRET");

  return {
    workerName: resolved.workerName,
    bucketName: resolved.bucketName,
    publicUrl: resolved.publicUrl,
    routes,
    configPath,
    workerPath,
  };
}

function deployArgv(options: CloudflareDeployOptions): ReadonlyArray<string> {
  return options.envFile == null ? options.argv ?? [] : ["--env", options.envFile, ...(options.argv ?? [])];
}

function resolveConfig(config: CloudflareServerConfig, env: DeployEnv): ResolvedCloudflareServerConfig {
  const customDomain = optional(config.customDomain) ?? optional(env.SCRATCHWORK_CLOUDFLARE_CUSTOM_DOMAIN);
  const bucket = config.r2Bucket;
  const bucketName = typeof bucket === "string"
    ? bucket
    : bucket?.name ?? optional(env.SCRATCHWORK_R2_BUCKET) ?? "scratchwork-sites";
  const bucketBinding = typeof bucket === "string" || bucket == null ? "SCRATCHWORK_R2" : bucket.binding ?? "SCRATCHWORK_R2";
  if (bucketBinding !== "SCRATCHWORK_R2") {
    throw new Error("Cloudflare r2Bucket.binding must be SCRATCHWORK_R2");
  }

  return {
    publicUrl: optional(config.publicUrl) ?? optional(env.SCRATCHWORK_PUBLIC_URL) ?? (customDomain == null ? undefined : `https://${customDomain}`),
    workerName: optional(config.workerName) ?? optional(env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME) ?? "scratchwork-server",
    compatibilityDate: optional(config.compatibilityDate) ?? optional(env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE) ?? "2026-06-01",
    bucketName,
    bucketBinding,
    route: optional(config.route) ?? optional(env.SCRATCHWORK_CLOUDFLARE_ROUTE),
    customDomain,
    zoneName: optional(config.zoneName) ?? optional(env.SCRATCHWORK_CLOUDFLARE_ZONE_NAME),
    routes: config.routes,
    skipBucketCreate: config.skipBucketCreate ?? env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE === "1",
  };
}

function configEnv(config: CloudflareServerConfig, resolved: ResolvedCloudflareServerConfig): DeployEnv {
  const env: DeployEnv = {};
  if (config.auth != null) env.SCRATCHWORK_AUTH = config.auth;
  if (config.googleClientId != null) env.SCRATCHWORK_GOOGLE_CLIENT_ID = config.googleClientId;
  if (config.authAllowedEmails != null) env.SCRATCHWORK_AUTH_ALLOWED_EMAILS = config.authAllowedEmails;
  if (config.authAllowedDomains != null) env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS = config.authAllowedDomains;
  if (config.authSessionSeconds != null) env.SCRATCHWORK_AUTH_SESSION_SECONDS = String(config.authSessionSeconds);
  if (config.allowPublicPublish != null) env.SCRATCHWORK_ALLOW_PUBLIC_PUBLISH = config.allowPublicPublish ? "1" : "";
  if (resolved.publicUrl != null) env.SCRATCHWORK_PUBLIC_URL = resolved.publicUrl;
  env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME = resolved.workerName;
  env.SCRATCHWORK_R2_BUCKET = resolved.bucketName;
  if (resolved.customDomain != null) env.SCRATCHWORK_CLOUDFLARE_CUSTOM_DOMAIN = resolved.customDomain;
  if (resolved.route != null) env.SCRATCHWORK_CLOUDFLARE_ROUTE = resolved.route;
  if (resolved.zoneName != null) env.SCRATCHWORK_CLOUDFLARE_ZONE_NAME = resolved.zoneName;
  env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE = resolved.compatibilityDate;
  if (resolved.skipBucketCreate) env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE = "1";
  return env;
}

/** Writes the generated Wrangler config consumed by the deploy command. */
async function writeConfig(
  config: ResolvedCloudflareServerConfig,
  env: DeployEnv,
  routes: ReadonlyArray<Record<string, string | boolean>>,
): Promise<void> {
  const vars: Record<string, string> = {};
  copyEnv(vars, env, "SCRATCHWORK_AUTH");
  copyEnv(vars, env, "SCRATCHWORK_GOOGLE_CLIENT_ID");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_EMAILS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_SESSION_SECONDS");
  if (config.publicUrl != null && config.publicUrl !== "") vars.SCRATCHWORK_PUBLIC_URL = config.publicUrl;
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: config.workerName,
        main: "worker.js",
        compatibility_date: config.compatibilityDate,
        r2_buckets: [
          {
            binding: config.bucketBinding,
            bucket_name: config.bucketName,
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

/** Builds optional custom-domain and route entries for Wrangler. */
function cloudflareRoutes(config: ResolvedCloudflareServerConfig): ReadonlyArray<Record<string, string | boolean>> {
  if (config.routes != null) {
    return config.routes.map((route) => ({
      pattern: route.pattern,
      ...(route.customDomain === true ? { custom_domain: true } : {}),
      ...zoneFor(route.pattern, route.zoneName ?? config.zoneName),
    }));
  }

  const routes: Array<Record<string, string | boolean>> = [];
  if (config.customDomain != null) {
    routes.push({ pattern: config.customDomain, custom_domain: true, ...zoneFor(config.customDomain, config.zoneName) });
  }
  if (config.route != null) {
    routes.push({ pattern: config.route, ...zoneFor(config.route, config.zoneName) });
  }
  return routes;
}

/** Infers the Cloudflare zone name from a route pattern unless configured. */
function zoneFor(pattern: string, configured: string | undefined): Record<string, string> {
  if (configured != null && configured.trim() !== "") return { zone_name: configured };
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? { zone_name: labels.slice(-2).join(".") } : {};
}

/** Refuses accidental public deploys and validates required Google auth secrets. */
function validateDeploymentAuth(env: DeployEnv): void {
  if ((env.SCRATCHWORK_AUTH ?? "").toLowerCase() !== "google") {
    if (env.SCRATCHWORK_ALLOW_PUBLIC_PUBLISH === "1") return;
    throw new Error("Cloudflare deploys require SCRATCHWORK_AUTH=google or explicit SCRATCHWORK_ALLOW_PUBLIC_PUBLISH=1");
  }
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) throw new Error(`${key} is required when SCRATCHWORK_AUTH=google`);
  }
}

/** Uploads one configured secret to Wrangler without printing its value. */
async function putSecret(commandEnv: Record<string, string>, env: DeployEnv, key: string): Promise<void> {
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

/** Creates the configured R2 bucket unless bucket creation is explicitly skipped. */
async function ensureBucket(
  config: ResolvedCloudflareServerConfig,
  run: ReturnType<typeof createRunner>["run"],
): Promise<void> {
  if (config.skipBucketCreate) return;
  const result = await run("wrangler", ["r2", "bucket", "create", config.bucketName], {
    allowFailure: true,
    capture: true,
    cwd: root,
  });
  if (result.ok || alreadyExists(result.stderr) || alreadyExists(result.stdout)) return;
  process.stderr.write(result.stderr || result.stdout);
  throw new Error(`Could not create R2 bucket ${config.bucketName}`);
}

/** Detects Wrangler's bucket-exists message across stdout and stderr. */
function alreadyExists(value: string): boolean {
  return value.toLowerCase().includes("already exists");
}

function optional(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
