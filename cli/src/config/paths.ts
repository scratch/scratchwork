import { homedir } from 'os'
import { join } from 'path'

/**
 * Centralized path definitions for all config and secrets files
 */
export const PATHS = {
  // Secrets directory - owner-only permissions (0o600)
  secretsDir: join(homedir(), '.scratchwork'),
  credentials: join(homedir(), '.scratchwork', 'credentials.json'),
  cfAccess: join(homedir(), '.scratchwork', 'cf-access.json'),
  secrets: join(homedir(), '.scratchwork', 'secrets.json'), // deprecated, see cf-access.json

  // Config directory - XDG-compliant, world-readable (0o644)
  configDir: join(homedir(), '.config', 'scratchwork'),
  userConfig: join(homedir(), '.config', 'scratchwork', 'config.toml'),

  // Project config - relative path
  projectConfig: '.scratchwork/project.toml',
} as const

export const DEFAULT_SERVER_URL = 'https://app.scratchwork.dev'

/**
 * Get the server URL from environment variable or return default.
 */
export async function getServerUrl(): Promise<string> {
  // Environment variable takes precedence
  if (process.env.SCRATCHWORK_SERVER_URL) {
    return process.env.SCRATCHWORK_SERVER_URL
  }

  // Fall back to default
  return DEFAULT_SERVER_URL
}

/**
 * Get the default server URL constant
 */
export function getDefaultServerUrl(): string {
  return DEFAULT_SERVER_URL
}
