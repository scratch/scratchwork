/**
 * Server settings shared by the cloud deploy packages: the `server` config shape a deploy
 * project declares, its resolution to app/content URLs, and its mapping onto the
 * SCRATCHWORK_* environment variables the server core reads at runtime.
 */
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import { readServerConfig } from "../core/src/config";
import { nonEmpty } from "../../shared/src/util/strings";
import type { DeployEnv } from "./env";

/** The `server` section of a deploy project's config, mapped onto SCRATCHWORK_* env vars. */
export interface ScratchworkServerConfig {
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
  /** Hostnames served from the homepage project; the first is canonical, the rest 308 to
   * it. Set together with homepageProject, and keep them distinct from appDomain and
   * contentDomain. Like those, they do not create DNS records or provider routing. */
  readonly homepageDomains?: ReadonlyArray<string>;
  /** Globally unique name of the project served on the homepage domains. */
  readonly homepageProject?: string;
  readonly usersCanSetProjectNames?: boolean;
  readonly defaultVisibility?: string;
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
 * optional platform fallback (e.g. a Cloudflare custom domain). */
export function resolveServerConfig(
  config: ScratchworkServerConfig,
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

/** Maps the server settings and resolved origins onto SCRATCHWORK_* environment variables. */
export function serverConfigEnv(config: ScratchworkServerConfig, resolved: ResolvedScratchworkServerConfig): DeployEnv {
  const env: DeployEnv = {};
  if (config.auth != null) env.SCRATCHWORK_AUTH = config.auth;
  if (config.googleClientId != null) env.SCRATCHWORK_GOOGLE_CLIENT_ID = config.googleClientId;
  if (config.authAllowedEmails != null) env.SCRATCHWORK_AUTH_ALLOWED_EMAILS = config.authAllowedEmails;
  if (config.authAllowedDomains != null) env.SCRATCHWORK_AUTH_ALLOWED_DOMAINS = config.authAllowedDomains;
  if (config.authSessionSeconds != null) env.SCRATCHWORK_AUTH_SESSION_SECONDS = String(config.authSessionSeconds);
  if (config.allowedUsers != null) env.SCRATCHWORK_ALLOWED_USERS = config.allowedUsers;
  if (config.maxVisibility != null) env.SCRATCHWORK_MAX_VISIBILITY = config.maxVisibility;
  if (config.shareAllowedDomains != null) env.SCRATCHWORK_SHARE_ALLOWED_DOMAINS = config.shareAllowedDomains;
  if (config.usersCanSetProjectNames != null) env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES = String(config.usersCanSetProjectNames);
  if (config.defaultVisibility != null) env.SCRATCHWORK_DEFAULT_VISIBILITY = config.defaultVisibility;
  if (config.homepageDomains != null && config.homepageDomains.length > 0) {
    env.SCRATCHWORK_HOMEPAGE_DOMAINS = config.homepageDomains.join(",");
  }
  if (config.homepageProject != null) env.SCRATCHWORK_HOMEPAGE_PROJECT = config.homepageProject;
  if (resolved.appUrl != null) env.SCRATCHWORK_APP_URL = resolved.appUrl;
  if (resolved.contentUrl != null) env.SCRATCHWORK_CONTENT_URL = resolved.contentUrl;
  return env;
}

/** The exact publish command that creates the configured homepage project, or null when
 * the deploy has no homepage. Deploys print this so a fresh server can be finished from
 * the terminal; until the project is published, home-domain requests serve the same
 * instructions. */
export function homepagePublishHint(
  config: ScratchworkServerConfig,
  resolved: ResolvedScratchworkServerConfig,
): string | null {
  if (config.homepageProject == null) return null;
  const server = resolved.appUrl ?? "<app url>";
  return `publish the homepage with: scratchwork publish --server ${server} --project ${config.homepageProject} --visibility public`;
}

/** Validates required OAuth secrets before a deploy. Auth cannot be disabled. */
export function validateDeploymentAuth(env: DeployEnv, platform: string): void {
  const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
  if (authMode !== "" && authMode !== "oauth") {
    throw new Error(`Invalid SCRATCHWORK_AUTH "${env.SCRATCHWORK_AUTH}": expected "oauth" (the only supported mode), or leave it unset`);
  }
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) {
      throw new Error(
        `${key} is required: ${platform} deploys always use OAuth. Create OAuth credentials at https://console.cloud.google.com/apis/credentials and generate a session secret with "openssl rand -hex 32".`,
      );
    }
  }
}

/** Validates the composed environment before a deploy by parsing it exactly as the
 * deployed server will at runtime. A value the server would reject (a malformed
 * maxVisibility group, a bad URL, a short session secret) must fail the deploy command,
 * not take the deployed server down on its first request. */
export function validateDeploymentConfig(env: DeployEnv, platform: string): void {
  validateDeploymentAuth(env, platform);
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
