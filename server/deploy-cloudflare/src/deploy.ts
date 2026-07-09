/**
 * Deploys the Scratchwork server as a Cloudflare Worker backed by R2 + D1, by building
 * the worker bundle and driving the Cloudflare REST API through the official
 * `cloudflare` SDK. The local runtime still shells out to `wrangler dev`, which is the
 * only way to run workerd locally. Like all deploy tooling under server/, this is
 * deliberately plain Promise-based script code, not Effect: it runs once on a
 * developer's machine.
 */
import Cloudflare, { APIError, toFile } from "cloudflare";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** One resolved route in Wrangler's config shape, also used to drive the routes API. */
type CloudflareRouteEntry = {
  readonly pattern: string;
  readonly custom_domain?: boolean;
  readonly zone_name?: string;
};

/** Build artifacts written under dist/: the worker bundles uploaded by deploys, plus
 * the Wrangler configs consumed by the local runtime and kept as deploy records. */
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
  validateDeploymentConfig(env, "Cloudflare");
  await run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${workerPath}`], { cwd: root });
  const routes = cloudflareRoutes(resolvedDeploy);
  const { client, accountId } = await createCloudflareClient(env);
  await ensureBucket(client, accountId, resolvedDeploy);
  const databaseId = await ensureDatabase(client, accountId, resolvedDeploy);
  const deployWithDatabase = { ...resolvedDeploy, d1DatabaseId: databaseId };
  const vars = workerVars(resolvedServer, env);
  await writeConfig(deployWithDatabase, vars, routes);
  await uploadWorker(client, accountId, deployWithDatabase, databaseId, vars);
  console.log(`Uploaded worker ${resolvedDeploy.workerName} (R2 ${resolvedDeploy.bucketName}, D1 ${resolvedDeploy.d1DatabaseName})`);
  await applyRoutes(client, accountId, resolvedDeploy.workerName, routes);
  if (routes.length > 0) console.log(`Routed ${routes.map((route) => route.pattern).join(", ")}`);
  await setWorkersDevSubdomain(client, accountId, resolvedDeploy.workerName, routes.length === 0);
  await putSecret(client, accountId, resolvedDeploy.workerName, env, "SCRATCHWORK_GOOGLE_CLIENT_SECRET");
  await putSecret(client, accountId, resolvedDeploy.workerName, env, "SCRATCHWORK_SESSION_SECRET");

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
  const serverConfig = config.server ?? {};
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
  validateDeploymentConfig(env, "local Cloudflare");
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
    workerVars(localServer, env, localVars),
    [],
    {
      outputPath: localConfigPath,
      main: access == null ? "worker.js" : "local-worker.js",
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

/** Collects the non-secret configuration variables passed to the Worker. */
function workerVars(
  server: ResolvedScratchworkServerConfig,
  env: DeployEnv,
  extraVars?: Readonly<Record<string, string>>,
): Record<string, string> {
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
  Object.assign(vars, extraVars);
  return vars;
}

/** Writes a Wrangler-format config under dist/. Remote deploys go through the API and
 * only keep this file as a record of what was deployed; the local runtime's config is
 * what `wrangler dev` actually reads. */
async function writeConfig(
  config: ResolvedCloudflareDeployConfig,
  vars: Readonly<Record<string, string>>,
  routes: ReadonlyArray<CloudflareRouteEntry>,
  options: {
    readonly outputPath?: string;
    readonly main?: string;
  } = {},
): Promise<void> {
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

/** Builds optional custom-domain and route entries in Wrangler's config shape. */
function cloudflareRoutes(config: ResolvedCloudflareDeployConfig): ReadonlyArray<CloudflareRouteEntry> {
  if (config.routes != null) {
    return config.routes.map((route) => routeEntry(route.pattern, route.customDomain === true, route.zoneName ?? config.zoneName));
  }

  const routes: Array<CloudflareRouteEntry> = [];
  if (config.customDomain != null) {
    routes.push(routeEntry(config.customDomain, true, config.zoneName));
  }
  if (config.route != null) {
    routes.push(routeEntry(config.route, false, config.zoneName));
  }
  return routes;
}

/** Builds one route entry with its zone name resolved. */
function routeEntry(pattern: string, customDomain: boolean, zoneName: string | undefined): CloudflareRouteEntry {
  const zone = zoneFor(pattern, zoneName);
  return {
    pattern,
    ...(customDomain ? { custom_domain: true } : {}),
    ...(zone == null ? {} : { zone_name: zone }),
  };
}

/** Infers the Cloudflare zone name from a route pattern unless configured. */
function zoneFor(pattern: string, configured: string | undefined): string | undefined {
  if (configured != null && configured.trim() !== "") return configured;
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join(".") : undefined;
}

/** Builds an authenticated API client and resolves the Cloudflare account to deploy to. */
async function createCloudflareClient(env: DeployEnv): Promise<{ client: Cloudflare; accountId: string }> {
  const apiToken = optional(env.CLOUDFLARE_API_TOKEN);
  const apiKey = optional(env.CLOUDFLARE_API_KEY);
  const apiEmail = optional(env.CLOUDFLARE_EMAIL);
  if (apiToken == null && (apiKey == null || apiEmail == null)) {
    throw new Error(
      "Cloudflare deploys need CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL) in the environment or an env file",
    );
  }
  const client = new Cloudflare({ apiToken: apiToken ?? null, apiKey: apiKey ?? null, apiEmail: apiEmail ?? null });

  const configured = optional(env.CLOUDFLARE_ACCOUNT_ID);
  if (configured != null) return { client, accountId: configured };
  const accounts: Array<{ id: string; name: string }> = [];
  for await (const account of client.accounts.list()) {
    accounts.push({ id: account.id, name: account.name });
  }
  if (accounts.length === 1) return { client, accountId: accounts[0].id };
  const names = accounts.map((account) => `${account.name} (${account.id})`).join(", ");
  throw new Error(
    accounts.length === 0
      ? "The Cloudflare API token has no visible accounts; set CLOUDFLARE_ACCOUNT_ID"
      : `The Cloudflare API token can see multiple accounts; set CLOUDFLARE_ACCOUNT_ID to one of: ${names}`,
  );
}

/** Uploads the built worker bundle with its R2, D1, and configuration bindings. The
 * upload replaces all bindings, so secrets set by earlier deploys are explicitly kept. */
async function uploadWorker(
  client: Cloudflare,
  accountId: string,
  config: ResolvedCloudflareDeployConfig,
  databaseId: string,
  vars: Readonly<Record<string, string>>,
): Promise<void> {
  const bundle = await readFile(workerPath);
  await client.workers.scripts.update(config.workerName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: config.compatibilityDate,
      bindings: [
        { type: "r2_bucket", name: config.bucketBinding, bucket_name: config.bucketName },
        { type: "d1", name: config.d1DatabaseBinding, database_id: databaseId },
        ...Object.entries(vars).map(([name, text]) => ({ type: "plain_text" as const, name, text })),
      ],
      keep_bindings: ["secret_text", "secret_key"],
    },
    files: [await toFile(bundle, "worker.js", { type: "application/javascript+module" })],
  });
}

/** Points the configured custom domains and zone routes at the deployed Worker. */
async function applyRoutes(
  client: Cloudflare,
  accountId: string,
  workerName: string,
  routes: ReadonlyArray<CloudflareRouteEntry>,
): Promise<void> {
  const zones = new Map<string, string>();
  const zoneId = async (entry: CloudflareRouteEntry): Promise<string> => {
    if (entry.zone_name == null) {
      throw new Error(`Cannot infer the Cloudflare zone for route "${entry.pattern}"; set zoneName`);
    }
    const cached = zones.get(entry.zone_name);
    if (cached != null) return cached;
    for await (const zone of client.zones.list({ name: entry.zone_name })) {
      if (zone.name === entry.zone_name) {
        zones.set(entry.zone_name, zone.id);
        return zone.id;
      }
    }
    throw new Error(`Cloudflare zone "${entry.zone_name}" not found for route "${entry.pattern}"`);
  };

  for (const entry of routes) {
    if (entry.custom_domain === true) {
      await client.workers.domains.update({
        account_id: accountId,
        hostname: entry.pattern,
        service: workerName,
        environment: "production",
        zone_id: await zoneId(entry),
      });
      continue;
    }
    const zone = await zoneId(entry);
    let existing: { id: string; script?: string } | undefined;
    for await (const route of client.workers.routes.list({ zone_id: zone })) {
      if (route.pattern === entry.pattern) {
        existing = route;
        break;
      }
    }
    if (existing == null) {
      await client.workers.routes.create({ zone_id: zone, pattern: entry.pattern, script: workerName });
    } else if (existing.script !== workerName) {
      await client.workers.routes.update(existing.id, { zone_id: zone, pattern: entry.pattern, script: workerName });
    }
  }
}

/** Matches Wrangler's workers.dev behavior: the subdomain serves the Worker only when
 * no routes or custom domains are configured. */
async function setWorkersDevSubdomain(
  client: Cloudflare,
  accountId: string,
  workerName: string,
  enabled: boolean,
): Promise<void> {
  await client.workers.scripts.subdomain.create(workerName, {
    account_id: accountId,
    enabled,
    previews_enabled: enabled,
  });
}

/** Uploads one configured secret through the API without printing its value. */
async function putSecret(
  client: Cloudflare,
  accountId: string,
  workerName: string,
  env: DeployEnv,
  key: string,
): Promise<void> {
  const value = env[key];
  if (value == null || value === "") return;
  await client.workers.scripts.secrets.update(workerName, {
    account_id: accountId,
    name: key,
    text: value,
    type: "secret_text",
  });
}

/** Creates the configured R2 bucket unless bucket creation is explicitly skipped. */
async function ensureBucket(client: Cloudflare, accountId: string, config: ResolvedCloudflareDeployConfig): Promise<void> {
  if (config.skipBucketCreate) return;
  try {
    await client.r2.buckets.create({ account_id: accountId, name: config.bucketName });
  } catch (error) {
    if (alreadyExists(error)) return;
    throw error;
  }
}

/** Creates or finds the configured D1 database and returns its database ID. */
async function ensureDatabase(client: Cloudflare, accountId: string, config: ResolvedCloudflareDeployConfig): Promise<string> {
  if (config.d1DatabaseId != null) return config.d1DatabaseId;

  for await (const database of client.d1.database.list({ account_id: accountId, name: config.d1DatabaseName })) {
    if (database.name === config.d1DatabaseName && database.uuid != null && database.uuid !== "") {
      return database.uuid;
    }
  }
  if (config.skipDatabaseCreate) {
    throw new Error(
      `D1 database ${config.d1DatabaseName} not found and creation is disabled; set SCRATCHWORK_D1_DATABASE_ID`,
    );
  }

  const created = await client.d1.database.create({ account_id: accountId, name: config.d1DatabaseName });
  if (created.uuid == null || created.uuid === "") {
    throw new Error(`Cloudflare did not return a database ID for D1 database ${config.d1DatabaseName}`);
  }
  return created.uuid;
}

/** Detects Cloudflare's resource-already-exists API error. */
function alreadyExists(error: unknown): boolean {
  return error instanceof APIError
    && error.errors.some((item) => item.code === 10004 || /already exists/i.test(item.message ?? ""));
}
