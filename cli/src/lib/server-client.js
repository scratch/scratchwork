/*
 * Thin client for the Scratchwork server API. Just fetch() — no dependencies.
 * One place builds auth headers; everything else is a small wrapper.
 *
 * Auth (buildHeaders): a stored/CI credential is { token, type, cfToken }.
 *   type "api_key" → X-Api-Key            (CI tokens, scratchwork_…)
 *   else           → Authorization: Bearer (session tokens; also legacy servers)
 *   cfToken        → cf-access-token        (Cloudflare Access mode)
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function buildHeaders(auth) {
  const h = {};
  if (auth && auth.token) {
    if (auth.type === "api_key") h["X-Api-Key"] = auth.token;
    else h["Authorization"] = `Bearer ${auth.token}`;
    if (auth.cfToken) h["cf-access-token"] = auth.cfToken;
  }
  return h;
}

async function parse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const base = (serverUrl) => serverUrl.replace(/\/+$/, "");

// Generic JSON request. Throws ApiError on a non-ok response.
async function apiFetch(serverUrl, path, { method = "GET", auth, json: jsonBody } = {}) {
  let res;
  const headers = buildHeaders(auth);
  let body;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }
  try {
    res = await fetch(`${base(serverUrl)}${path}`, { method, headers, body });
  } catch (err) {
    throw new ApiError(`Could not reach ${serverUrl}: ${err.message}`, 0);
  }
  const parsed = await parse(res);
  if (!res.ok) {
    const msg = parsed && typeof parsed === "object" && parsed.error ? parsed.error : `Server error (${res.status})`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed;
}

// POST a gzipped bundle. Returns the server's JSON { id, url, version, ... }.
export async function deploy({ serverUrl, auth, name, id, visibility, bundle, timeoutMs = 120000 }) {
  const qs = new URLSearchParams();
  if (name) qs.set("name", name);
  if (id) qs.set("id", id);
  if (visibility) qs.set("visibility", visibility);
  const url = `${base(serverUrl)}/api/deploy?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-scratchwork-bundle+gzip", ...buildHeaders(auth) },
      body: bundle,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new ApiError("Upload timed out", 0);
    throw new ApiError(`Could not reach ${serverUrl}: ${err.message}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const body = await parse(res);
  if (!res.ok) {
    const msg = body && typeof body === "object" && body.error ? body.error : `Deploy failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body;
}

// GET /api/whoami — { authRequired, authenticated, user? }.
export async function whoami({ serverUrl, auth }) {
  return apiFetch(serverUrl, "/api/whoami", { auth });
}

// GET /api/me — { user } (accounts mode). Throws 401 if not authenticated.
export async function getCurrentUser({ serverUrl, auth }) {
  return apiFetch(serverUrl, "/api/me", { auth });
}

// ---- API keys (CI tokens) ----
export const listTokens = ({ serverUrl, auth }) => apiFetch(serverUrl, "/api/tokens", { auth });
export const createToken = ({ serverUrl, auth, name, expiresDays }) =>
  apiFetch(serverUrl, "/api/tokens", { method: "POST", auth, json: { name, expires_days: expiresDays } });
export const revokeToken = ({ serverUrl, auth, id }) =>
  apiFetch(serverUrl, `/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE", auth });

// ---- share tokens ----
export const listShareTokens = ({ serverUrl, auth, project }) =>
  apiFetch(serverUrl, `/api/projects/${encodeURIComponent(project)}/share-tokens`, { auth });
export const createShareToken = ({ serverUrl, auth, project, name, duration }) =>
  apiFetch(serverUrl, `/api/projects/${encodeURIComponent(project)}/share-tokens`, { method: "POST", auth, json: { name, duration } });
export const revokeShareToken = ({ serverUrl, auth, project, id }) =>
  apiFetch(serverUrl, `/api/projects/${encodeURIComponent(project)}/share-tokens/${encodeURIComponent(id)}`, { method: "DELETE", auth });

// ---- device flow (fallback poll-based login) ----
export const startDeviceAuth = ({ serverUrl }) => apiFetch(serverUrl, "/api/login/device/start", { method: "POST", json: {} });
export async function pollDeviceToken({ serverUrl, deviceCode }) {
  // Returns { access_token } or { error: 'authorization_pending' | ... }. The
  // poll endpoint uses non-2xx for pending, so swallow ApiError into its body.
  try {
    return await apiFetch(serverUrl, "/api/login/device/token", { method: "POST", json: { device_code: deviceCode } });
  } catch (err) {
    if (err instanceof ApiError && err.body && typeof err.body === "object") return err.body;
    throw err;
  }
}
