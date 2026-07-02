import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyEnv, definedEnv, loadDeployEnv, type DeployEnv } from "./deploy-env";
import { createRunner } from "./deploy-proc";

export interface CloudflareR2BucketConfig {
  readonly name: string;
  readonly binding?: "SCRATCHWORK_R2";
}

export interface CloudflareD1DatabaseConfig {
  readonly name: string;
  readonly binding?: "SCRATCHWORK_D1";
  readonly id?: string;
}

export interface CloudflareRouteConfig {
  readonly pattern: string;
  readonly zoneName?: string;
  readonly customDomain?: boolean;
}

export interface ScratchworkServerConfig {
  readonly publicUrl?: string;
  readonly auth?: "oauth";
  readonly googleClientId?: string;
  readonly authAllowedEmails?: string;
  readonly authAllowedDomains?: string;
  readonly authSessionSeconds?: number;
  readonly allowedUsers?: string;
  readonly maxVisibility?: string;
  readonly shareAllowedDomains?: string;
  readonly appDomain?: string;
  readonly contentDomain?: string;
  readonly projectPath?: "workspace/project" | "domain/username/project" | "username/project" | "random";
  readonly defaultWorkspace?: "personal" | "random" | "required";
  readonly defaultVisibility?: string;
}

export interface CloudflareDeployConfig {
  readonly workerName?: string;
  readonly compatibilityDate?: string;
  readonly r2Bucket?: string | CloudflareR2BucketConfig;
  readonly d1Database?: string | CloudflareD1DatabaseConfig;
  readonly route?: string;
  readonly customDomain?: string;
  readonly zoneName?: string;
  readonly routes?: ReadonlyArray<CloudflareRouteConfig>;
  readonly skipBucketCreate?: boolean;
  readonly skipDatabaseCreate?: boolean;
}

export interface CloudflareDeployServerConfig {
  readonly server?: ScratchworkServerConfig;
  readonly deploy?: CloudflareDeployConfig;
}

/** @deprecated Use CloudflareDeployServerConfig. */
export type CloudflareServerConfig = CloudflareDeployServerConfig;

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

interface ResolvedScratchworkServerConfig {
  readonly appUrl?: string;
  readonly contentUrl?: string;
}

interface ResolvedCloudflareDeployConfig {
  readonly workerName: string;
  readonly compatibilityDate: string;
  readonly bucketName: string;
  readonly bucketBinding: "SCRATCHWORK_R2";
  readonly d1DatabaseName: string;
  readonly d1DatabaseBinding: "SCRATCHWORK_D1";
  readonly d1DatabaseId?: string;
  readonly route?: string;
  readonly customDomain?: string;
  readonly zoneName?: string;
  readonly routes?: ReadonlyArray<CloudflareRouteConfig>;
  readonly skipBucketCreate: boolean;
  readonly skipDatabaseCreate: boolean;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const workerPath = join(dist, "worker.js");
const configPath = join(dist, "wrangler.jsonc");

/** Deploys the Scratchwork server as a Cloudflare Worker. */
export async function deployServer(
  config: CloudflareDeployServerConfig = {},
  options: CloudflareDeployOptions = {},
): Promise<CloudflareDeployResult> {
  const loadedEnv = await loadDeployEnv({
    packageRoot: root,
    argv: deployArgv(options),
    processEnv: options.processEnv ?? process.env,
    loadDefaultEnvFiles: options.loadPackageEnvFiles === true,
    explicitEnvRoots: options.loadPackageEnvFiles === true ? undefined : [process.cwd()],
  });
  const serverConfig = config.server ?? {};
  const deployConfig = config.deploy ?? {};
  const resolvedDeploy = resolveDeployConfig(deployConfig, loadedEnv.env);
  const resolvedServer = resolveServerConfig(serverConfig, loadedEnv.env, resolvedDeploy);
  const env = {
    ...loadedEnv.env,
    ...serverConfigEnv(serverConfig, resolvedServer),
    ...deployConfigEnv(resolvedDeploy),
  };
  const commandEnv = definedEnv(env);
  const { run } = createRunner(commandEnv);

  await mkdir(dist, { recursive: true });
  validateDeploymentAuth(env);
  await run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${workerPath}`], { cwd: root });
  const routes = cloudflareRoutes(resolvedDeploy);
  await ensureBucket(resolvedDeploy, run);
  const databaseId = await ensureDatabase(resolvedDeploy, run);
  const deployWithDatabase = { ...resolvedDeploy, d1DatabaseId: databaseId };
  await writeConfig(deployWithDatabase, resolvedServer, env, routes);
  await run("wrangler", ["deploy", "--config", configPath, "--no-bundle"], { cwd: root });
  await putSecret(commandEnv, env, "SCRATCHWORK_GOOGLE_CLIENT_SECRET");
  await putSecret(commandEnv, env, "SCRATCHWORK_SESSION_SECRET");

  return {
    workerName: resolvedDeploy.workerName,
    bucketName: resolvedDeploy.bucketName,
    publicUrl: resolvedServer.appUrl,
    routes,
    configPath,
    workerPath,
  };
}

function deployArgv(options: CloudflareDeployOptions): ReadonlyArray<string> {
  return options.envFile == null ? options.argv ?? [] : ["--env", options.envFile, ...(options.argv ?? [])];
}

function resolveServerConfig(
  config: ScratchworkServerConfig,
  env: DeployEnv,
  deploy: ResolvedCloudflareDeployConfig,
): ResolvedScratchworkServerConfig {
  return {
    appUrl: optional(config.appDomain) == null
      ? optional(config.publicUrl) ?? optional(env.SCRATCHWORK_APP_URL) ?? optional(env.SCRATCHWORK_PUBLIC_URL) ?? (deploy.customDomain == null ? undefined : `https://${deploy.customDomain}`)
      : `https://${config.appDomain}`,
    contentUrl: optional(config.contentDomain) == null
      ? optional(config.publicUrl) ?? optional(env.SCRATCHWORK_CONTENT_URL) ?? optional(env.SCRATCHWORK_PUBLIC_URL) ?? (deploy.customDomain == null ? undefined : `https://${deploy.customDomain}`)
      : `https://${config.contentDomain}`,
  };
}

function resolveDeployConfig(config: CloudflareDeployConfig, env: DeployEnv): ResolvedCloudflareDeployConfig {
  const customDomain = optional(config.customDomain) ?? optional(env.SCRATCHWORK_CLOUDFLARE_CUSTOM_DOMAIN);
  const bucket = config.r2Bucket;
  const bucketName = typeof bucket === "string"
    ? bucket
    : bucket?.name ?? optional(env.SCRATCHWORK_R2_BUCKET) ?? "scratchwork-sites";
  const bucketBinding = typeof bucket === "string" || bucket == null
    ? "SCRATCHWORK_R2"
    : bucket.binding ?? "SCRATCHWORK_R2";
  if (bucketBinding !== "SCRATCHWORK_R2") {
    throw new Error("Cloudflare r2Bucket.binding must be SCRATCHWORK_R2");
  }
  const database = config.d1Database;
  const d1DatabaseName = typeof database === "string"
    ? database
    : database?.name ?? optional(env.SCRATCHWORK_D1_DATABASE) ?? "scratchwork-projects";
  const d1DatabaseBinding = typeof database === "string" || database == null
    ? "SCRATCHWORK_D1"
    : database.binding ?? "SCRATCHWORK_D1";
  if (d1DatabaseBinding !== "SCRATCHWORK_D1") {
    throw new Error("Cloudflare d1Database.binding must be SCRATCHWORK_D1");
  }

  return {
    workerName: optional(config.workerName) ?? optional(env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME) ?? "scratchwork-server",
    compatibilityDate: optional(config.compatibilityDate) ?? optional(env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE) ?? "2026-06-01",
    bucketName,
    bucketBinding,
    d1DatabaseName,
    d1DatabaseBinding,
    d1DatabaseId: typeof database === "string" || database == null
      ? optional(env.SCRATCHWORK_D1_DATABASE_ID)
      : optional(database.id) ?? optional(env.SCRATCHWORK_D1_DATABASE_ID),
    route: optional(config.route) ?? optional(env.SCRATCHWORK_CLOUDFLARE_ROUTE),
    customDomain,
    zoneName: optional(config.zoneName) ?? optional(env.SCRATCHWORK_CLOUDFLARE_ZONE_NAME),
    routes: config.routes,
    skipBucketCreate: config.skipBucketCreate ?? env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE === "1",
    skipDatabaseCreate: config.skipDatabaseCreate ?? env.SCRATCHWORK_CLOUDFLARE_SKIP_DATABASE_CREATE === "1",
  };
}

function serverConfigEnv(config: ScratchworkServerConfig, resolved: ResolvedScratchworkServerConfig): DeployEnv {
  const env: DeployEnv = {};
  if (config.auth != null) env.SCRATCHWORK_AUTH = config.auth;
  if (config.googleClientId != null) env.SCRATCHWORK_GOOGLE_CLIENT_ID = config.googleClientId;
  if (config.authAllowedEmails != null) env.SCRATCHWORK_AUTH_ALLOWED_EMAILS = config.authAllowedEmails;
  if (config.authAllowedDomains != null) env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS = config.authAllowedDomains;
  if (config.authSessionSeconds != null) env.SCRATCHWORK_AUTH_SESSION_SECONDS = String(config.authSessionSeconds);
  if (config.allowedUsers != null) env.SCRATCHWORK_ALLOWED_USERS = config.allowedUsers;
  if (config.maxVisibility != null) env.SCRATCHWORK_MAX_VISIBILITY = config.maxVisibility;
  if (config.shareAllowedDomains != null) env.SCRATCHWORK_SHARE_ALLOWED_DOMAINS = config.shareAllowedDomains;
  if (config.projectPath != null) env.SCRATCHWORK_PROJECT_PATH = config.projectPath;
  if (config.defaultWorkspace != null) env.SCRATCHWORK_DEFAULT_WORKSPACE = config.defaultWorkspace;
  if (config.defaultVisibility != null) env.SCRATCHWORK_DEFAULT_VISIBILITY = config.defaultVisibility;
  if (resolved.appUrl != null) env.SCRATCHWORK_APP_URL = resolved.appUrl;
  if (resolved.contentUrl != null) env.SCRATCHWORK_CONTENT_URL = resolved.contentUrl;
  return env;
}

function deployConfigEnv(resolved: ResolvedCloudflareDeployConfig): DeployEnv {
  const env: DeployEnv = {};
  env.SCRATCHWORK_CLOUDFLARE_WORKER_NAME = resolved.workerName;
  env.SCRATCHWORK_R2_BUCKET = resolved.bucketName;
  env.SCRATCHWORK_D1_DATABASE = resolved.d1DatabaseName;
  if (resolved.d1DatabaseId != null) env.SCRATCHWORK_D1_DATABASE_ID = resolved.d1DatabaseId;
  if (resolved.customDomain != null) env.SCRATCHWORK_CLOUDFLARE_CUSTOM_DOMAIN = resolved.customDomain;
  if (resolved.route != null) env.SCRATCHWORK_CLOUDFLARE_ROUTE = resolved.route;
  if (resolved.zoneName != null) env.SCRATCHWORK_CLOUDFLARE_ZONE_NAME = resolved.zoneName;
  env.SCRATCHWORK_CLOUDFLARE_COMPATIBILITY_DATE = resolved.compatibilityDate;
  if (resolved.skipBucketCreate) env.SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE = "1";
  if (resolved.skipDatabaseCreate) env.SCRATCHWORK_CLOUDFLARE_SKIP_DATABASE_CREATE = "1";
  return env;
}

/** Writes the generated Wrangler config consumed by the deploy command. */
async function writeConfig(
  config: ResolvedCloudflareDeployConfig,
  server: ResolvedScratchworkServerConfig,
  env: DeployEnv,
  routes: ReadonlyArray<Record<string, string | boolean>>,
): Promise<void> {
  const vars: Record<string, string> = {};
  copyEnv(vars, env, "SCRATCHWORK_AUTH");
  copyEnv(vars, env, "SCRATCHWORK_GOOGLE_CLIENT_ID");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_EMAILS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_ALLOWED_USERS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_SESSION_SECONDS");
  copyEnv(vars, env, "SCRATCHWORK_MAX_VISIBILITY");
  copyEnv(vars, env, "SCRATCHWORK_SHARE_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_PROJECT_PATH");
  copyEnv(vars, env, "SCRATCHWORK_DEFAULT_WORKSPACE");
  copyEnv(vars, env, "SCRATCHWORK_DEFAULT_VISIBILITY");
  if (server.appUrl != null && server.appUrl !== "") vars.SCRATCHWORK_APP_URL = server.appUrl;
  if (server.contentUrl != null && server.contentUrl !== "") vars.SCRATCHWORK_CONTENT_URL = server.contentUrl;
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
        d1_databases: [
          {
            binding: config.d1DatabaseBinding,
            database_name: config.d1DatabaseName,
            database_id: config.d1DatabaseId,
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
function cloudflareRoutes(config: ResolvedCloudflareDeployConfig): ReadonlyArray<Record<string, string | boolean>> {
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

/** Validates required OAuth secrets. Auth cannot be disabled. */
function validateDeploymentAuth(env: DeployEnv): void {
  const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
  if (authMode !== "" && authMode !== "oauth") {
    throw new Error('SCRATCHWORK_AUTH must be "oauth" when set');
  }
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) throw new Error(`${key} is required: Cloudflare deploys always use OAuth`);
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
  config: ResolvedCloudflareDeployConfig,
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

/** Creates or finds the configured D1 database and returns its Wrangler database ID. */
async function ensureDatabase(
  config: ResolvedCloudflareDeployConfig,
  run: ReturnType<typeof createRunner>["run"],
): Promise<string | undefined> {
  if (config.d1DatabaseId != null) return config.d1DatabaseId;

  const listed = await run("wrangler", ["d1", "list", "--json"], {
    allowFailure: true,
    capture: true,
    cwd: root,
  });
  const existing = listed.ok ? databaseIdFromList(listed.stdout, config.d1DatabaseName) : undefined;
  if (existing != null) return existing;
  if (config.skipDatabaseCreate) return undefined;

  const created = await run("wrangler", ["d1", "create", config.d1DatabaseName], {
    capture: true,
    cwd: root,
  });
  return databaseIdFromText(created.stdout) ?? databaseIdFromText(created.stderr);
}

/** Detects Wrangler's bucket-exists message across stdout and stderr. */
function alreadyExists(value: string): boolean {
  return value.toLowerCase().includes("already exists");
}

function databaseIdFromList(text: string, name: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    for (const item of parsed) {
      if (typeof item !== "object" || item == null) continue;
      const record = item as Record<string, unknown>;
      if (record.name !== name) continue;
      const id = record.uuid ?? record.id ?? record.database_id;
      return typeof id === "string" && id !== "" ? id : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function databaseIdFromText(text: string): string | undefined {
  return /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(text)?.[1];
}

function optional(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
