/*
 * CLI configuration + credentials, kept deliberately small.
 *
 *   ~/.config/scratchwork/credentials.json   per-server credentials (mode 0600)
 *   ~/.config/scratchwork/config.json        global defaults (e.g. server)
 *
 * A credentials entry is { token, type?, cfToken?, user? }:
 *   - type "session"  → sent as Authorization: Bearer (browser/device login)
 *   - type "api_key"  → sent as X-Api-Key (CI/env tokens)
 *   - legacy entries (just { token }) are treated as bearer, so old single-token
 *     servers keep working.
 *
 * Zero dependencies — node:fs + node:os only.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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

// Full auth to use for a server: { token, type, cfToken } or null. The env var
// wins (CI). An env token prefixed "scratchwork_" is an API key (X-Api-Key);
// anything else is a legacy/session bearer token. Stored creds carry their type.
export function resolveAuth(serverUrl) {
  const envTok = process.env.SCRATCHWORK_TOKEN;
  if (envTok) {
    return { token: envTok, type: envTok.startsWith("scratchwork_") ? "api_key" : "bearer" };
  }
  const creds = loadCredentials(serverUrl);
  if (!creds) return null;
  return { token: creds.token, type: creds.type || "bearer", cfToken: creds.cfToken };
}

// ---- global config ----------------------------------------------------------

export function loadGlobalConfig() {
  return readJson(globalConfigPath()) || {};
}

export function saveGlobalConfig(cfg) {
  writeJsonSecure(globalConfigPath(), cfg);
}

// Resolve the server URL by priority:
//   1. explicit flag  2. global default  3. DEFAULT_SERVER
export function resolveServerUrl({ flag } = {}) {
  if (flag) return flag.replace(/\/+$/, "");
  const g = loadGlobalConfig();
  if (g.server) return String(g.server).replace(/\/+$/, "");
  return DEFAULT_SERVER;
}
