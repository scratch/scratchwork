/*
 * CLI configuration + credentials, kept deliberately small.
 *
 *   ~/.config/scratchwork/credentials.json   per-server deploy tokens (mode 0600)
 *   ~/.config/scratchwork/config.json        global defaults (e.g. default server)
 *   <project>/.scratchwork.json              per-project: { id, name, server }
 *
 * The per-project file is what makes re-publishing land on the SAME URL: it
 * remembers the server-assigned project id. Honors XDG_CONFIG_HOME.
 *
 * Zero dependencies — node:fs + node:os only.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SERVER = "https://scratchwork.dev";

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "scratchwork");
}

const credentialsPath = () => join(configDir(), "credentials.json");
const globalConfigPath = () => join(configDir(), "config.json");

// Trailing-slash- and case-insensitive key for a server URL.
export function normalizeServerUrl(url) {
  return String(url || "").replace(/\/+$/, "").toLowerCase();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonSecure(path, data, mode) {
  mkdirSync(configDir(), { recursive: true });
  // Pass mode to writeFileSync so a NEW file is created with restricted
  // permissions atomically (no world-readable window). chmod afterward covers
  // the case where the file already existed with looser permissions.
  writeFileSync(path, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  if (mode) {
    try {
      chmodSync(path, mode);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
  }
}

// ---- credentials ------------------------------------------------------------

export function loadCredentials(serverUrl) {
  const all = readJson(credentialsPath()) || {};
  const entry = all[normalizeServerUrl(serverUrl)];
  return entry && typeof entry.token === "string" ? entry : null;
}

export function saveCredentials(serverUrl, entry) {
  const all = readJson(credentialsPath()) || {};
  all[normalizeServerUrl(serverUrl)] = entry;
  writeJsonSecure(credentialsPath(), all, 0o600);
}

export function clearCredentials(serverUrl) {
  const all = readJson(credentialsPath()) || {};
  const key = normalizeServerUrl(serverUrl);
  if (key in all) {
    delete all[key];
    writeJsonSecure(credentialsPath(), all, 0o600);
  }
}

// Token to use for a server: env var wins (CI-friendly), then stored creds.
export function resolveToken(serverUrl) {
  if (process.env.SCRATCHWORK_TOKEN) return process.env.SCRATCHWORK_TOKEN;
  const creds = loadCredentials(serverUrl);
  return creds ? creds.token : null;
}

// ---- global config ----------------------------------------------------------

export function loadGlobalConfig() {
  return readJson(globalConfigPath()) || {};
}

export function saveGlobalConfig(cfg) {
  writeJsonSecure(globalConfigPath(), cfg);
}

// ---- per-project config -----------------------------------------------------

export function projectConfigPath(dir) {
  return join(dir, ".scratchwork.json");
}

export function loadProjectConfig(dir) {
  return readJson(projectConfigPath(dir)) || {};
}

export function saveProjectConfig(dir, cfg) {
  writeFileSync(projectConfigPath(dir), JSON.stringify(cfg, null, 2) + "\n");
}

// Resolve the server URL for a publish, by priority:
//   1. explicit flag  2. project config  3. global default  4. DEFAULT_SERVER
export function resolveServerUrl({ flag, projectConfig } = {}) {
  if (flag) return flag.replace(/\/+$/, "");
  if (projectConfig && projectConfig.server) return projectConfig.server.replace(/\/+$/, "");
  const g = loadGlobalConfig();
  if (g.server) return String(g.server).replace(/\/+$/, "");
  return DEFAULT_SERVER;
}
