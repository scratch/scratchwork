/*
 * Thin client for the Scratchwork auth API. Just fetch() — no dependencies.
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

// GET /api/whoami — { authRequired, authenticated, user? }.
export async function whoami({ serverUrl, auth }) {
  return apiFetch(serverUrl, "/api/whoami", { auth });
}

// GET /api/me — { user } (accounts mode). Throws 401 if not authenticated.
export async function getCurrentUser({ serverUrl, auth }) {
  return apiFetch(serverUrl, "/api/me", { auth });
}

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
