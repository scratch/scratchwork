/**
 * Server settings shared by the cloud deploy packages: the `server` config shape a deploy
 * project declares, its resolution to app/content URLs, and its mapping onto the
 * SCRATCHWORK_* environment variables the server core reads at runtime.
 */
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import { readServerConfig } from "../config.ts";
import type { DeployEnv } from "./env.ts";

/** The `server` section of a deploy project's config, mapped onto SCRATCHWORK_* env vars. */
export interface ScratchworkServerConfig {
  /** How users authenticate. Required: a deploy must choose its auth mode explicitly. */
  readonly auth: "oauth" | "cloudflare-access";
  readonly googleClientId?: string;
  /** Cloudflare Access team domain, like "myteam" or "myteam.cloudflareaccess.com". */
  readonly cfAccessTeamDomain?: string;
  /** Audience (AUD) tag of the Cloudflare Access application protecting this server. */
  readonly cfAccessAud?: string;
  readonly authAllowedEmails?: string;
  readonly authAllowedDomains?: string;
  readonly authSessionSeconds?: number;
  readonly allowedUsers?: string;
  /** false: no project on this server may be public. Default: true. */
  readonly allowPublicProjects?: boolean;
  /** When non-empty, share grants must fall inside these domains (comma-separated). */
  readonly allowedShareDomains?: string;
  readonly appDomain?: string;
  readonly contentDomain?: string;
  /** Hostnames served from the homepage project; the first is canonical, the rest 308 to
   * it. Set together with homepageProject, and keep them distinct from appDomain and
   * contentDomain. Like those, they do not create DNS records or provider routing. */
  readonly homepageDomains?: ReadonlyArray<string>;
  /** Globally unique name of the project served on the homepage domains. */
  readonly homepageProject?: string;
  readonly usersCanSetProjectNames?: boolean;
}

/** Options shared by every deployServer entry point. */
export interface DeployServerOptions {
  readonly envFile?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly processEnv?: DeployEnv;
  readonly loadPackageEnvFiles?: boolean;
}

/** The app/content origins a deploy resolved from config, env, and platform fallbacks. */
export interface ResolvedScratchworkServerConfig {
  readonly appUrl?: string;
  readonly contentUrl?: string;
}

/** Resolves the app and content origins: configured domain, then env value, then the
 * optional platform fallback (e.g. a Cloudflare custom domain). Accepts a partial
 * config so env-driven deploys (no `server` section) can resolve from env alone. */
export function resolveServerConfig(
  config: Partial<ScratchworkServerConfig>,
  env: DeployEnv,
  fallbackUrl?: string,
): ResolvedScratchworkServerConfig {
  return {
    appUrl: optional(config.appDomain) == null
      ? optional(env.SCRATCHWORK_APP_URL) ?? fallbackUrl
      : `https://${config.appDomain}`,
    contentUrl: optional(config.contentDomain) == null
      ? optional(env.SCRATCHWORK_CONTENT_URL) ?? fallbackUrl
      : `https://${config.contentDomain}`,
  };
}

/** One config-backed SCRATCHWORK_* variable: the env var name paired with the function
 * that extracts and stringifies its value from the server config. Returning undefined
 * omits the variable. Entries read a partial config so env-driven deploys with no
 * `server` section can compose an environment too. */
export interface ServerConfigEnvEntry {
  readonly name: string;
  readonly value: (config: Partial<ScratchworkServerConfig>) => string | undefined;
}

/** The single source of truth mapping ScratchworkServerConfig fields onto their
 * SCRATCHWORK_* environment variables. The resolved app/content origins are handled
 * separately (see serverConfigEnv). Only non-secret settings belong here: cloud deploys
 * forward every name in this table as a plaintext platform variable, so secrets like
 * SCRATCHWORK_GOOGLE_CLIENT_SECRET and SCRATCHWORK_SESSION_SECRET must never be added. */
export const serverConfigEnvEntries: ReadonlyArray<ServerConfigEnvEntry> = [
  { name: "SCRATCHWORK_AUTH", value: (config) => config.auth },
  { name: "SCRATCHWORK_GOOGLE_CLIENT_ID", value: (config) => config.googleClientId },
  { name: "SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN", value: (config) => config.cfAccessTeamDomain },
  { name: "SCRATCHWORK_CF_ACCESS_AUD", value: (config) => config.cfAccessAud },
  { name: "SCRATCHWORK_AUTH_ALLOWED_EMAILS", value: (config) => config.authAllowedEmails },
  { name: "SCRATCHWORK_AUTH_ALLOWED_DOMAINS", value: (config) => config.authAllowedDomains },
  { name: "SCRATCHWORK_AUTH_SESSION_SECONDS", value: (config) => stringified(config.authSessionSeconds) },
  { name: "SCRATCHWORK_ALLOWED_USERS", value: (config) => config.allowedUsers },
  { name: "SCRATCHWORK_ALLOW_PUBLIC_PROJECTS", value: (config) => stringified(config.allowPublicProjects) },
  { name: "SCRATCHWORK_ALLOWED_SHARE_DOMAINS", value: (config) => config.allowedShareDomains },
  { name: "SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES", value: (config) => stringified(config.usersCanSetProjectNames) },
  {
    name: "SCRATCHWORK_HOMEPAGE_DOMAINS",
    value: (config) => config.homepageDomains == null || config.homepageDomains.length === 0
      ? undefined
      : config.homepageDomains.join(","),
  },
  { name: "SCRATCHWORK_HOMEPAGE_PROJECT", value: (config) => config.homepageProject },
];

/** The SCRATCHWORK_* names of every config-backed (non-secret) server setting. */
export const serverConfigEnvNames: ReadonlyArray<string> = serverConfigEnvEntries.map((entry) => entry.name);

/** Serializes an optional number or boolean setting with String(), keeping undefined. */
function stringified(value: number | boolean | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

/** Maps the server settings and resolved origins onto SCRATCHWORK_* environment variables.
 * Accepts a partial config for env-driven deploys with no `server` section; those must
 * supply SCRATCHWORK_AUTH through the environment, which validateDeploymentAuth enforces. */
export function serverConfigEnv(config: Partial<ScratchworkServerConfig>, resolved: ResolvedScratchworkServerConfig): DeployEnv {
  const env: DeployEnv = {};
  for (const entry of serverConfigEnvEntries) {
    const value = entry.value(config);
    if (value != null) env[entry.name] = value;
  }
  if (resolved.appUrl != null) env.SCRATCHWORK_APP_URL = resolved.appUrl;
  if (resolved.contentUrl != null) env.SCRATCHWORK_CONTENT_URL = resolved.contentUrl;
  return env;
}

/** The exact publish command that creates the configured homepage project, or null when
 * the deploy has no homepage. Deploys print this so a fresh server can be finished from
 * the terminal; until the project is published, home-domain requests serve the same
 * instructions. */
export function homepagePublishHint(
  config: Partial<ScratchworkServerConfig>,
  resolved: ResolvedScratchworkServerConfig,
): string | null {
  if (config.homepageProject == null) return null;
  const server = resolved.appUrl ?? "<app url>";
  return `publish the homepage with: scratchwork publish --server ${server} --project ${config.homepageProject} --public`;
}

/** Validates required auth settings before a deploy. Auth cannot be disabled, and the
 * mode must be chosen explicitly. */
export function validateDeploymentAuth(env: DeployEnv): void {
  const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
  if (authMode === "") {
    throw new Error('SCRATCHWORK_AUTH is required: set it to "oauth" or "cloudflare-access".');
  }
  if (authMode !== "oauth" && authMode !== "cloudflare-access") {
    throw new Error(`Invalid SCRATCHWORK_AUTH "${env.SCRATCHWORK_AUTH}": expected "oauth" or "cloudflare-access"`);
  }
  if (authMode === "cloudflare-access") {
    for (const key of ["SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN", "SCRATCHWORK_CF_ACCESS_AUD", "SCRATCHWORK_SESSION_SECRET"]) {
      if (!env[key]) {
        throw new Error(
          `${key} is required for Cloudflare Access auth: copy the team domain and application Audience (AUD) tag from the Cloudflare Zero Trust dashboard, and generate a session secret with "openssl rand -hex 32".`,
        );
      }
    }
    return;
  }
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) {
      throw new Error(
        `${key} is required for OAuth auth: create OAuth credentials at https://console.cloud.google.com/apis/credentials and generate a session secret with "openssl rand -hex 32".`,
      );
    }
  }
}

/** Validates the composed environment before a deploy by parsing it exactly as the
 * deployed server will at runtime. A value the server would reject (a malformed
 * allowedShareDomains list, a bad URL, a short session secret) must fail the deploy command,
 * not take the deployed server down on its first request. */
export function validateDeploymentConfig(env: DeployEnv): void {
  validateDeploymentAuth(env);
  const parsed = Effect.runSync(Effect.either(readServerConfig(env)));
  if (Either.isLeft(parsed)) {
    throw new Error(`Invalid server config: ${parsed.left.message}`);
  }
}

/** Prepends the options' env file to argv as a `--env` argument for loadDeployEnv. */
export function deployArgv(options: DeployServerOptions): ReadonlyArray<string> {
  return options.envFile == null ? options.argv ?? [] : ["--env", options.envFile, ...(options.argv ?? [])];
}

/** Normalizes empty strings to undefined so `??` fallback chains skip them. */
export function optional(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
