/*
 * Thin client for the Scratchwork publishing server API. Just fetch() — no
 * dependencies. Two endpoints: deploy (upload a bundle) and whoami (verify a
 * token / probe whether a server requires auth).
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// POST a gzipped bundle. Returns the server's JSON { id, url, version, ... }.
export async function deploy({ serverUrl, token, name, id, visibility, bundle, timeoutMs = 120000 }) {
  const qs = new URLSearchParams();
  if (name) qs.set("name", name);
  if (id) qs.set("id", id);
  if (visibility) qs.set("visibility", visibility);
  const url = `${serverUrl.replace(/\/+$/, "")}/api/deploy?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-scratchwork-bundle+gzip",
        ...authHeaders(token),
      },
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

// GET /api/whoami — { authRequired, authenticated }.
export async function whoami({ serverUrl, token }) {
  let res;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/whoami`, { headers: authHeaders(token) });
  } catch (err) {
    throw new ApiError(`Could not reach ${serverUrl}: ${err.message}`, 0);
  }
  const body = await parse(res);
  if (!res.ok) {
    throw new ApiError(`Server error (${res.status})`, res.status, body);
  }
  return body;
}
