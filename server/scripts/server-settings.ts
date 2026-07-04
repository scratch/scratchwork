/**
 * Server settings shared by the cloud deploy packages: the `server` config shape a deploy
 * project declares, its resolution to app/content URLs, and its mapping onto the
 * SCRATCHWORK_* environment variables the server core reads at runtime.
 */
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
  readonly projectPath?: "workspace/project" | "domain/username/project" | "username/project" | "random";
  readonly defaultWorkspace?: "personal" | "random" | "required";
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
  if (config.projectPath != null) env.SCRATCHWORK_PROJECT_PATH = config.projectPath;
  if (config.defaultWorkspace != null) env.SCRATCHWORK_DEFAULT_WORKSPACE = config.defaultWorkspace;
  if (config.defaultVisibility != null) env.SCRATCHWORK_DEFAULT_VISIBILITY = config.defaultVisibility;
  if (resolved.appUrl != null) env.SCRATCHWORK_APP_URL = resolved.appUrl;
  if (resolved.contentUrl != null) env.SCRATCHWORK_CONTENT_URL = resolved.contentUrl;
  return env;
}

/** Validates required OAuth secrets before a deploy. Auth cannot be disabled. */
export function validateDeploymentAuth(env: DeployEnv, platform: string): void {
  const authMode = (env.SCRATCHWORK_AUTH ?? "").toLowerCase();
  if (authMode !== "" && authMode !== "oauth") {
    throw new Error('SCRATCHWORK_AUTH must be "oauth" when set');
  }
  for (const key of ["SCRATCHWORK_GOOGLE_CLIENT_ID", "SCRATCHWORK_GOOGLE_CLIENT_SECRET", "SCRATCHWORK_SESSION_SECRET"]) {
    if (!env[key]) throw new Error(`${key} is required: ${platform} deploys always use OAuth`);
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
