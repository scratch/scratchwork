/**
 * Deploys the Scratchwork server as a Cloudflare Worker backed by R2 + D1, by building
 * the worker bundle, generating a Wrangler config under dist/, and shelling out to the
 * `wrangler` CLI. Like all deploy tooling under server/, this is deliberately plain
 * Promise-based script code, not Effect: it runs once on a developer's machine.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyEnv, definedEnv, loadDeployEnv, type DeployEnv } from "../../scripts/env";
import { createRunner } from "../../scripts/proc";
import {
  deployArgv,
  homepagePublishHint,
  optional,
  resolveServerConfig,
  serverConfigEnv,
  validateDeploymentConfig,
  type DeployServerOptions,
  type ResolvedScratchworkServerConfig,
  type ScratchworkServerConfig,
} from "../../scripts/server-settings";

/** Deploy options and server settings, shared with the other deploy packages. */
export type { DeployServerOptions as CloudflareDeployOptions, ScratchworkServerConfig };

/** R2 bucket settings; the binding name is fixed to what worker.ts expects. */
export interface CloudflareR2BucketConfig {
  readonly name: string;
  readonly binding?: "SCRATCHWORK_R2";
}

/** D1 database settings; the binding name is fixed to what worker.ts expects. */
export interface CloudflareD1DatabaseConfig {
  readonly name: string;
  readonly binding?: "SCRATCHWORK_D1";
  readonly id?: string;
}

/** One Wrangler route entry: a pattern plus optional zone/custom-domain flags. */
export interface CloudflareRouteConfig {
  readonly pattern: string;
  readonly zoneName?: string;
  readonly customDomain?: boolean;
}

/** Cloudflare-specific deploy settings; unset values fall back to env vars and defaults. */
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

/** A deploy project's full config: server settings plus Cloudflare deploy settings. */
export interface CloudflareDeployServerConfig {
  readonly server?: ScratchworkServerConfig;
  readonly deploy?: CloudflareDeployConfig;
}

/** One identity for the local Cloudflare Access edge simulator. */
export interface CloudflareLocalAccessConfig {
  /** Email asserted by the simulated Access application. */
  readonly email?: string;
}

/** Options for running the Worker and its R2/D1 bindings entirely locally. */
export interface CloudflareLocalOptions extends DeployServerOptions {
  /** Local listen port. Defaults to 8787. */
  readonly port?: number;
  /** Local listen address. Defaults to 127.0.0.1. */
  readonly ip?: string;
  /** Wrangler state directory. Defaults to .scratchwork-cloudflare-data in the caller's directory. */
  readonly persistTo?: string;
  /** Enable an edge-style Access assertion. `true` uses developer@example.com; an
   * object can select the email. SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL is another opt-in. */
  readonly simulateAccess?: boolean | CloudflareLocalAccessConfig;
}

/** What deployServer reports back after a successful deploy. */
export interface CloudflareDeployResult {
  readonly workerName: string;
  readonly bucketName: string;
  readonly publicUrl?: string;
  readonly routes: ReadonlyArray<Record<string, string | boolean>>;
  readonly configPath: string;
  readonly workerPath: string;
}

/** CloudflareDeployConfig with every fallback applied. */
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

/** Build artifacts written under dist/ for Wrangler to consume. */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const workerPath = join(dist, "worker.js");
const configPath = join(dist, "wrangler.jsonc");
const localWorkerPath = join(dist, "local-worker.js");
const localConfigPath = join(dist, "wrangler.local.jsonc");
const localDevVarsPath = join(dist, ".dev.vars");
const LOCAL_D1_ID = "00000000-0000-0000-0000-000000000001";
const LOCAL_ACCESS_TEAM = "scratchwork-local.cloudflareaccess.com";
const LOCAL_ACCESS_AUDIENCE = "scratchwork-local";
const LOCAL_SESSION_SECRET = "scratchwork-local-session-secret-not-for-production";

/** Deploys the Scratchwork server as a Cloudflare Worker. */
export async function deployServer(
  config: CloudflareDeployServerConfig = {},
  options: DeployServerOptions = {},
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
  const resolvedServer = resolveServerConfig(
    serverConfig,
    loadedEnv.env,
    resolvedDeploy.customDomain == null ? undefined : `https://${resolvedDeploy.customDomain}`,
  );
  const env = {
    ...loadedEnv.env,
    ...serverConfigEnv(serverConfig, resolvedServer),
    ...deployConfigEnv(resolvedDeploy),
  };
  const commandEnv = definedEnv(env);
  const { run } = createRunner(commandEnv);

  await mkdir(dist, { recursive: true });
  validateDeploymentConfig(env);
  await run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${workerPath}`], { cwd: root });
  const routes = cloudflareRoutes(resolvedDeploy);
  await ensureBucket(resolvedDeploy, run);
  const databaseId = await ensureDatabase(resolvedDeploy, run);
  const deployWithDatabase = { ...resolvedDeploy, d1DatabaseId: databaseId };
  await writeConfig(deployWithDatabase, resolvedServer, env, routes);
  await run("wrangler", ["deploy", "--config", configPath, "--no-bundle"], { cwd: root });
  await putSecret(commandEnv, env, "SCRATCHWORK_GOOGLE_CLIENT_SECRET");
  await putSecret(commandEnv, env, "SCRATCHWORK_SESSION_SECRET");

  const homepageHint = homepagePublishHint(serverConfig, resolvedServer);
  if (homepageHint != null) console.log(homepageHint);

  return {
    workerName: resolvedDeploy.workerName,
    bucketName: resolvedDeploy.bucketName,
    publicUrl: resolvedServer.appUrl,
    routes,
    configPath,
    workerPath,
  };
}

/** Runs the production Worker entry point under Wrangler's local workerd runtime, with
 * persistent local R2 and D1 bindings. Cloudflare Access can optionally be simulated by
 * a local-only wrapper that injects a correctly signed assertion before each request. */
export async function runLocalCloudflareServer(
  config: CloudflareDeployServerConfig = {},
  options: CloudflareLocalOptions = {},
): Promise<void> {
  const callerDirectory = process.cwd();
  const loadedEnv = await loadDeployEnv({
    packageRoot: root,
    argv: deployArgv(options),
    processEnv: options.processEnv ?? process.env,
    loadDefaultEnvFiles: options.loadPackageEnvFiles === true,
    explicitEnvRoots: options.loadPackageEnvFiles === true ? undefined : [callerDirectory],
  });
  const serverConfig: Partial<ScratchworkServerConfig> = config.server ?? {};
  const resolvedDeploy = resolveDeployConfig(config.deploy ?? {}, loadedEnv.env);
  const port = localPort(options.port, loadedEnv.env.PORT ?? loadedEnv.env.SCRATCHWORK_PORT);
  const appUrl = `http://localhost:${port}`;
  const splitHosts = serverConfig.appDomain != null
    && serverConfig.contentDomain != null
    && serverConfig.appDomain !== serverConfig.contentDomain;
  const localServer: ResolvedScratchworkServerConfig = {
    appUrl,
    contentUrl: splitHosts ? `http://pages.localhost:${port}` : appUrl,
  };
  const localServerEnv = serverConfigEnv(serverConfig, localServer);
  if (serverConfig.homepageProject != null) {
    localServerEnv.SCRATCHWORK_HOMEPAGE_DOMAINS = `http://home.localhost:${port}`;
  }
  const env: DeployEnv = {
    ...loadedEnv.env,
    ...localServerEnv,
    ...deployConfigEnv(resolvedDeploy),
  };

  const access = localAccessSimulation(options.simulateAccess, env.SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL);
  if (access != null) Object.assign(env, await localAccessEnv(access.email, env.SCRATCHWORK_SESSION_SECRET));

  await mkdir(dist, { recursive: true });
  validateDeploymentConfig(env);
  const source = access == null ? "src/worker.ts" : "src/local-worker.ts";
  const output = access == null ? workerPath : localWorkerPath;
  await createRunner(definedEnv(env)).run(
    "bun",
    ["build", source, "--target=browser", "--format=esm", `--outfile=${output}`],
    { cwd: root },
  );

  await writeLocalDevVars(env);
  const localVars: Record<string, string> = {};
  copyEnv(localVars, env, "SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL");
  await writeConfig(
    { ...resolvedDeploy, d1DatabaseId: LOCAL_D1_ID },
    localServer,
    env,
    [],
    {
      outputPath: localConfigPath,
      main: access == null ? "worker.js" : "local-worker.js",
      extraVars: localVars,
    },
  );

  const persistTo = resolve(callerDirectory, options.persistTo ?? ".scratchwork-cloudflare-data");
  console.log([
    "scratchwork local Cloudflare deploy",
    `app      ${localServer.appUrl}`,
    `content  ${localServer.contentUrl}`,
    ...(serverConfig.homepageProject == null ? [] : [`home     http://home.localhost:${port} (project "${serverConfig.homepageProject}")`]),
    `storage  R2 + D1 (${persistTo})`,
    ...(access == null ? [] : [`access   ${access.email}`]),
  ].join("\n"));

  await createRunner(definedEnv(env)).run(
    "wrangler",
    [
      "dev",
      "--config",
      localConfigPath,
      "--local",
      "--persist-to",
      persistTo,
      "--ip",
      options.ip ?? "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: root },
  );
}

/** Writes local secrets in Wrangler's dev-only secret file instead of ordinary vars.
 * Wrangler prints vars in its startup binding table; .dev.vars values stay hidden. */
async function writeLocalDevVars(env: DeployEnv): Promise<void> {
  const lines: Array<string> = [];
  for (const key of [
    "SCRATCHWORK_GOOGLE_CLIENT_SECRET",
    "SCRATCHWORK_SESSION_SECRET",
    "SCRATCHWORK_LOCAL_CF_ACCESS_PRIVATE_JWK",
    "SCRATCHWORK_LOCAL_CF_ACCESS_JWKS",
  ]) {
    const value = env[key];
    if (value == null || value === "") continue;
    // The generated JWK documents contain many double quotes. Wrangler's dotenv
    // parser preserves backslashes inside a JSON-stringified value, so use a
    // single-quoted dotenv value for these machine-generated JSON documents.
    const encoded = key.endsWith("_JWK") || key.endsWith("_JWKS")
      ? `'${value}'`
      : JSON.stringify(value);
    lines.push(`${key}=${encoded}`);
  }
  await writeFile(localDevVarsPath, `${lines.join("\n")}\n`);
}

/** Applies env-var and default fallbacks to the Cloudflare deploy settings. */
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

/** Maps resolved Cloudflare deploy settings back onto their environment variables. */
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
  options: {
    readonly outputPath?: string;
    readonly main?: string;
    readonly extraVars?: Readonly<Record<string, string>>;
  } = {},
): Promise<void> {
  const vars: Record<string, string> = {};
  copyEnv(vars, env, "SCRATCHWORK_AUTH");
  copyEnv(vars, env, "SCRATCHWORK_GOOGLE_CLIENT_ID");
  copyEnv(vars, env, "SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN");
  copyEnv(vars, env, "SCRATCHWORK_CF_ACCESS_AUD");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_EMAILS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_ALLOWED_USERS");
  copyEnv(vars, env, "SCRATCHWORK_AUTH_SESSION_SECONDS");
  copyEnv(vars, env, "SCRATCHWORK_MAX_VISIBILITY");
  copyEnv(vars, env, "SCRATCHWORK_SHARE_ALLOWED_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES");
  copyEnv(vars, env, "SCRATCHWORK_DEFAULT_VISIBILITY");
  copyEnv(vars, env, "SCRATCHWORK_HOMEPAGE_DOMAINS");
  copyEnv(vars, env, "SCRATCHWORK_HOMEPAGE_PROJECT");
  if (server.appUrl != null && server.appUrl !== "") vars.SCRATCHWORK_APP_URL = server.appUrl;
  if (server.contentUrl != null && server.contentUrl !== "") vars.SCRATCHWORK_CONTENT_URL = server.contentUrl;
  Object.assign(vars, options.extraVars);
  await writeFile(
    options.outputPath ?? configPath,
    JSON.stringify(
      {
        name: config.workerName,
        main: options.main ?? "worker.js",
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

/** Resolves and validates the local listen port. */
function localPort(configured: number | undefined, fromEnv: string | undefined): number {
  const value = configured ?? (fromEnv == null || fromEnv === "" ? 8787 : Number(fromEnv));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid local Cloudflare port "${configured ?? fromEnv}": expected an integer between 1 and 65535`);
  }
  return value;
}

/** Decides whether Access simulation was requested through code or the environment. */
function localAccessSimulation(
  configured: boolean | CloudflareLocalAccessConfig | undefined,
  envEmail: string | undefined,
): { readonly email: string } | null {
  if (configured === false) return null;
  const requested = configured === true || typeof configured === "object" || (envEmail != null && envEmail !== "");
  if (!requested) return null;
  const email = (typeof configured === "object" ? configured.email : undefined) ?? envEmail ?? "developer@example.com";
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Invalid local Cloudflare Access email "${email}"`);
  }
  return { email: normalized };
}

/** Generates the throwaway key material and config values used only by the local Access
 * wrapper. The private key is written to dist/wrangler.local.jsonc, which is ignored. */
async function localAccessEnv(email: string, sessionSecret: string | undefined): Promise<DeployEnv> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  const keyMetadata = { kid: "scratchwork-local-access", alg: "RS256", use: "sig" } as const;
  return {
    SCRATCHWORK_AUTH: "cloudflare-access",
    SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: LOCAL_ACCESS_TEAM,
    SCRATCHWORK_CF_ACCESS_AUD: LOCAL_ACCESS_AUDIENCE,
    SCRATCHWORK_SESSION_SECRET: sessionSecret ?? LOCAL_SESSION_SECRET,
    SCRATCHWORK_LOCAL_CF_ACCESS_EMAIL: email,
    SCRATCHWORK_LOCAL_CF_ACCESS_PRIVATE_JWK: JSON.stringify({ ...privateJwk, ...keyMetadata }),
    SCRATCHWORK_LOCAL_CF_ACCESS_JWKS: JSON.stringify({ keys: [{ ...publicJwk, ...keyMetadata }] }),
  };
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

/** Detects Wrangler's resource-already-exists message. */
function alreadyExists(value: string): boolean {
  return value.toLowerCase().includes("already exists");
}

/** Finds the database ID for a name in `wrangler d1 list --json` output. */
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

/** Extracts the first UUID in Wrangler's `d1 create` output. */
function databaseIdFromText(text: string): string | undefined {
  return /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(text)?.[1];
}
