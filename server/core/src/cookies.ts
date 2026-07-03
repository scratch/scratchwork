/**
 * Cookie construction and parsing for the auth flows. Each cookie has a secure name
 * (__Host-/__Secure- prefixed) used on HTTPS origins and a plain name for local HTTP.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";

const COOKIE_NAME = "scratchwork_session";
const SECURE_COOKIE_NAME = "__Host-scratchwork_session";
const OAUTH_STATE_COOKIE_NAME = "scratchwork_oauth_state";
const SECURE_OAUTH_STATE_COOKIE_NAME = "__Host-scratchwork_oauth_state";
const PROJECT_ACCESS_COOKIE_PREFIX = "scratchwork_access_";
const SECURE_PROJECT_ACCESS_COOKIE_PREFIX = "__Secure-scratchwork_access_";

/** Lifetime of the browser-bound OAuth state cookie and the state token it carries. */
export const STATE_TTL_SECONDS = 10 * 60;

/** Extracts the session token from either secure or local-dev cookie names. */
export function cookieToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  return cookieValue(request, [COOKIE_NAME, SECURE_COOKIE_NAME]);
}

/** Extracts the browser-bound OAuth state cookie for the current origin mode. */
export function oauthStateToken(request: HttpServerRequest.HttpServerRequest, baseUrl: string): string | undefined {
  return cookieValue(request, [oauthStateCookieName(baseUrl)]);
}

/** Builds the Set-Cookie header for a session token. */
export function sessionCookie(token: string, baseUrl: string, ttlSeconds: number): string {
  return [
    `${cookieName(baseUrl)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
}

/** Builds the browser-bound OAuth state cookie. */
export function oauthStateCookie(state: string, baseUrl: string): string {
  return [
    `${oauthStateCookieName(baseUrl)}=${encodeURIComponent(state)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL_SECONDS}`,
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
}

/** Builds the Set-Cookie header that clears the session token. */
export function clearSessionCookie(baseUrl: string): string {
  return [
    `${cookieName(baseUrl)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
}

/** Builds the Set-Cookie header for a redeemed project-access token, scoped to the project
 * path on the content host. */
export function projectAccessCookie(token: string, routePath: string, baseUrl: string, ttlSeconds: number): string {
  const secure = baseUrl.startsWith("https://");
  return [
    `${projectAccessCookieName(routePath, secure)}=${encodeURIComponent(token)}`,
    `Path=/${routePath}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

/** Reads every candidate project-access cookie value for a route path. */
export function projectAccessCookieValues(request: HttpServerRequest.HttpServerRequest, routePath: string): ReadonlyArray<string> {
  return cookieValues(request, [projectAccessCookieName(routePath, true), projectAccessCookieName(routePath, false)]);
}

/** Names the per-project content-access cookie. Route paths are `[A-Za-z0-9._-]` segments,
 * so flattening `/` to `_` yields a valid cookie name; the flattened form can collide across
 * projects (`a/b` vs `a_b`), but their `Path` attributes differ and the signed value is bound
 * to the exact route path, so a colliding cookie merely fails verification. */
function projectAccessCookieName(routePath: string, secure: boolean): string {
  const prefix = secure ? SECURE_PROJECT_ACCESS_COOKIE_PREFIX : PROJECT_ACCESS_COOKIE_PREFIX;
  return `${prefix}${routePath.replace(/\//g, "_")}`;
}

/** Finds and decodes the first matching cookie value from the request. */
function cookieValue(request: HttpServerRequest.HttpServerRequest, names: ReadonlyArray<string>): string | undefined {
  return cookieValues(request, names)[0];
}

/** Finds and decodes every matching cookie value from the request. Duplicates happen
 * legitimately (same name under different Path attributes), so token-cookie readers must
 * try each value rather than trust the first. */
function cookieValues(request: HttpServerRequest.HttpServerRequest, names: ReadonlyArray<string>): ReadonlyArray<string> {
  const header = request.headers.cookie;
  if (header == null) return [];
  const values: Array<string> = [];
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (names.includes(name)) {
      try {
        values.push(decodeURIComponent(valueParts.join("=")));
      } catch {
        // Skip undecodable values; other cookies under the same name may still verify.
      }
    }
  }
  return values;
}

/** Returns the Secure cookie attribute when the public origin is HTTPS. */
function secureCookie(baseUrl: string): string {
  return baseUrl.startsWith("https://") ? "Secure" : "";
}

/** Chooses the session cookie name for HTTPS or local HTTP. */
function cookieName(baseUrl: string): string {
  return baseUrl.startsWith("https://") ? SECURE_COOKIE_NAME : COOKIE_NAME;
}

/** Chooses the OAuth state cookie name for HTTPS or local HTTP. */
function oauthStateCookieName(baseUrl: string): string {
  return baseUrl.startsWith("https://") ? SECURE_OAUTH_STATE_COOKIE_NAME : OAUTH_STATE_COOKIE_NAME;
}
