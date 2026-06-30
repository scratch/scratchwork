import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { base64UrlToBytes, bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { errorMessage, isRecord, parseJson } from "../../../shared/src/util/json";
import { ServerConfig, type AuthConfig } from "./config";
import { verifyGoogleIdToken, type GoogleIdTokenClaims } from "./google-jwt";
import { timingSafeEqual } from "./tokens";

const COOKIE_NAME = "scratchwork_session";
const SECURE_COOKIE_NAME = "__Host-scratchwork_session";
const OAUTH_STATE_COOKIE_NAME = "scratchwork_oauth_state";
const SECURE_OAUTH_STATE_COOKIE_NAME = "__Host-scratchwork_oauth_state";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_VERSION = 1;
const STATE_TTL_SECONDS = 10 * 60;
const REDIRECT_MAX_LENGTH = 2048;

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly picture?: string;
}

interface SessionPayload {
  readonly version: typeof SESSION_VERSION;
  readonly provider: "google";
  readonly user: AuthUser;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface OAuthState {
  readonly version: typeof SESSION_VERSION;
  readonly returnTo: string;
  readonly cliRedirect?: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

interface GoogleTokenResponse {
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AuthShape {
  readonly enabled: boolean;
  readonly currentUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  readonly requireUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  readonly requireApiUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  readonly login: (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    baseUrl: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError>;
  readonly callback: (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    baseUrl: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError>;
  readonly logout: (baseUrl: string) => HttpServerResponse.HttpServerResponse;
  readonly loginRedirect: (url: URL, baseUrl: string) => HttpServerResponse.HttpServerResponse;
}

export class Auth extends Context.Tag("@scratchwork/server/Auth")<Auth, AuthShape>() {}

export const AuthLive: Layer.Layer<Auth, never, ServerConfig> = Layer.effect(
  Auth,
  Effect.map(ServerConfig, (config) => makeAuth(config.auth)),
);

/** Creates the auth service implementation for disabled or Google auth modes. */
export function makeAuth(config: AuthConfig): AuthShape {
  if (config._tag === "Disabled") {
    return Auth.of({
      enabled: false,
      currentUser: () => Effect.succeed(null),
      requireUser: () => Effect.succeed(null),
      requireApiUser: () => Effect.succeed(null),
      login: () => Effect.fail(new AuthError({ status: 404, message: "Authentication is disabled" })),
      callback: () => Effect.fail(new AuthError({ status: 404, message: "Authentication is disabled" })),
      logout: () => HttpServerResponse.redirect("/", { status: 302 }),
      loginRedirect: () => HttpServerResponse.redirect("/", { status: 302 }),
    });
  }

  return Auth.of({
    enabled: true,

    currentUser: (request) =>
      Effect.gen(function* () {
        const token = bearerToken(request) ?? cookieToken(request);
        if (token == null) return null;
        return yield* verifySessionToken(token, config).pipe(Effect.catchAll(() => Effect.succeed(null)));
      }),

    requireUser: (request) =>
      Effect.gen(function* () {
        const user = yield* verifySessionTokenFromRequest(request, config);
        if (user == null) {
          return yield* Effect.fail(new AuthError({ status: 401, message: "Authentication required" }));
        }
        return user;
      }),

    requireApiUser: (request) =>
      Effect.gen(function* () {
        const token = bearerToken(request);
        const user = token == null ? null : yield* verifySessionToken(token, config);
        if (user == null) {
          return yield* Effect.fail(new AuthError({ status: 401, message: "Authentication required" }));
        }
        return user;
      }),

    login: (_request, url, baseUrl) =>
      Effect.gen(function* () {
        const returnTo = safeReturnTo(url.searchParams.get("returnTo")) ?? "/";
        const cliRedirect = safeCliRedirect(url.searchParams.get("cli_redirect"));
        const nonce = randomNonce();
        const state = yield* signValue(
          {
            version: SESSION_VERSION,
            returnTo,
            cliRedirect,
            nonce,
            expiresAt: epochSeconds() + STATE_TTL_SECONDS,
          } satisfies OAuthState,
          config.sessionSecret,
        );

        const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", callbackUrl(baseUrl));
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("nonce", nonce);
        authUrl.searchParams.set("prompt", "select_account");
        return HttpServerResponse.redirect(authUrl, {
          status: 302,
          headers: {
            "set-cookie": oauthStateCookie(state, baseUrl),
          },
        });
      }),

    callback: (request, url, baseUrl) =>
      Effect.gen(function* () {
        const error = url.searchParams.get("error");
        if (error != null) {
          return yield* Effect.fail(
            new AuthError({ status: 400, message: `Google OAuth failed: ${error}` }),
          );
        }

        const code = url.searchParams.get("code");
        const stateToken = url.searchParams.get("state");
        if (!code || !stateToken) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Missing OAuth callback parameters" }));
        }
        if (oauthStateToken(request, baseUrl) !== stateToken) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Invalid OAuth state cookie" }));
        }

        const state = yield* verifySignedValue<OAuthState>(stateToken, config.sessionSecret);
        if (!isOAuthState(state) || state.expiresAt < epochSeconds()) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Invalid or expired OAuth state" }));
        }

        const user = yield* exchangeGoogleCode(code, callbackUrl(baseUrl), state.nonce, config);
        const token = yield* createSessionToken(user, config);

        if (state.cliRedirect != null) {
          const redirectUrl = new URL(state.cliRedirect);
          redirectUrl.searchParams.set("token", token);
          redirectUrl.searchParams.set("server", baseUrl);
          redirectUrl.searchParams.set("email", user.email);
          return HttpServerResponse.redirect(redirectUrl, { status: 302 });
        }

        return HttpServerResponse.redirect(state.returnTo, {
          status: 302,
          headers: {
            "set-cookie": sessionCookie(token, baseUrl, config.sessionTtlSeconds),
          },
        });
      }),

    logout: (baseUrl) =>
      HttpServerResponse.redirect("/", {
        status: 302,
        headers: {
          "set-cookie": clearSessionCookie(baseUrl),
        },
      }),

    loginRedirect: (url, baseUrl) => {
      const loginUrl = new URL("/auth/login", baseUrl);
      loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
      return HttpServerResponse.redirect(loginUrl, { status: 302 });
    },
  });
}

/** Signs a portable session token for browser cookies and CLI bearer auth. */
export function createSessionToken(
  user: AuthUser,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<string, AuthError> {
  const issuedAt = epochSeconds();
  return signValue(
    {
      version: SESSION_VERSION,
      provider: "google",
      user,
      issuedAt,
      expiresAt: issuedAt + config.sessionTtlSeconds,
    } satisfies SessionPayload,
    config.sessionSecret,
  );
}

/** Reads bearer or cookie credentials and verifies the contained session token. */
function verifySessionTokenFromRequest(
  request: HttpServerRequest.HttpServerRequest,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<AuthUser | null, AuthError> {
  const token = bearerToken(request) ?? cookieToken(request);
  return token == null ? Effect.succeed(null) : verifySessionToken(token, config);
}

/** Verifies one signed session token and applies current allow-list rules. */
function verifySessionToken(
  token: string,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<AuthUser | null, AuthError> {
  return Effect.gen(function* () {
    const payload = yield* verifySignedValue<SessionPayload>(token, config.sessionSecret);
    if (!isSessionPayload(payload) || payload.expiresAt < epochSeconds()) return null;
    if (!allowedUser(payload.user, config)) return null;
    return payload.user;
  });
}

/** Exchanges a Google OAuth code and verifies the returned ID token. */
function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  nonce: string,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<AuthUser, AuthError> {
  return Effect.gen(function* () {
    const idToken = yield* Effect.tryPromise({
      try: async () => {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
        const response = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        const json = (await response.json().catch(() => null)) as GoogleTokenResponse | null;
        if (!response.ok || json == null || json.id_token == null) {
          throw new AuthError({
            status: 401,
            message: json?.error_description ?? json?.error ?? "Google token exchange failed",
          });
        }
        return json.id_token;
      },
      catch: (cause) =>
        cause instanceof AuthError
          ? cause
          : new AuthError({ status: 500, message: errorMessage(cause) }),
    });

    const claims = yield* verifyGoogleIdToken(idToken, {
      clientId: config.clientId,
      expectedNonce: nonce,
    }).pipe(
      Effect.mapError((cause) => new AuthError({ status: 401, message: cause.message, cause })),
    );
    const user = userFromClaims(claims, config);
    if (user == null) {
      return yield* Effect.fail(new AuthError({ status: 403, message: "Google account is not allowed" }));
    }
    return user;
  });
}

/** Converts verified Google claims into the auth user shape. */
function userFromClaims(
  claims: GoogleIdTokenClaims,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): AuthUser | null {
  const user: AuthUser = {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
  return allowedUser(user, config) ? user : null;
}

/** Checks whether a verified Google user passes email/domain allow lists. */
function allowedUser(user: AuthUser, config: Extract<AuthConfig, { readonly _tag: "Google" }>): boolean {
  if (config.allowedEmails.size === 0 && config.allowedDomains.size === 0) return true;
  if (config.allowedEmails.has(user.email.toLowerCase())) return true;
  const domain = user.email.split("@")[1]?.toLowerCase();
  return domain != null && config.allowedDomains.has(domain);
}

/** Signs arbitrary JSON as a compact HMAC token. */
function signValue(value: unknown, secret: string): Effect.Effect<string, AuthError> {
  return Effect.tryPromise({
    try: async () => {
      const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
      const signature = await hmac(payload, secret);
      return `${payload}.${signature}`;
    },
    catch: (cause) => new AuthError({ status: 500, message: `Could not sign auth token: ${errorMessage(cause)}` }),
  });
}

/** Verifies and decodes a compact HMAC JSON token. */
function verifySignedValue<A>(token: string, secret: string): Effect.Effect<A, AuthError> {
  return Effect.tryPromise({
    try: async () => {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) throw new Error("invalid token");
      const expected = await hmac(payload, secret);
      if (!timingSafeEqual(signature, expected)) throw new Error("invalid token signature");
      const bytes = base64UrlToBytes(payload);
      if (bytes == null) throw new Error("invalid token payload");
      return parseJson(new TextDecoder().decode(bytes)) as A;
    },
    catch: () => new AuthError({ status: 401, message: "Invalid auth token" }),
  });
}

/** Computes a base64url HMAC signature for signed auth values. */
async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Extracts a bearer token from the Authorization header. */
function bearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (header == null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** Extracts the session token from either secure or local-dev cookie names. */
function cookieToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  return cookieValue(request, [COOKIE_NAME, SECURE_COOKIE_NAME]);
}

/** Extracts the browser-bound OAuth state cookie for the current origin mode. */
function oauthStateToken(request: HttpServerRequest.HttpServerRequest, baseUrl: string): string | undefined {
  return cookieValue(request, [oauthStateCookieName(baseUrl)]);
}

/** Finds and decodes the first matching cookie value from the request. */
function cookieValue(request: HttpServerRequest.HttpServerRequest, names: ReadonlyArray<string>): string | undefined {
  const header = request.headers.cookie;
  if (header == null) return undefined;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (names.includes(name)) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Builds the Set-Cookie header for a session token. */
function sessionCookie(token: string, baseUrl: string, ttlSeconds: number): string {
  const secure = secureCookie(baseUrl);
  return [
    `${cookieName(baseUrl)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
    secure,
  ].filter(Boolean).join("; ");
}

/** Builds the browser-bound OAuth state cookie. */
function oauthStateCookie(state: string, baseUrl: string): string {
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
function clearSessionCookie(baseUrl: string): string {
  return [
    `${cookieName(baseUrl)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
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

/** Sanitizes a post-login redirect path to stay on the server origin. */
function safeReturnTo(value: string | null): string | null {
  if (value == null || value === "") return null;
  if (value.length > REDIRECT_MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\0\r\n\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\0\r\n\x00-\x1f\x7f]/.test(decoded)) return null;
    const url = new URL(decoded, "https://scratchwork.invalid");
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Accepts only loopback HTTP callbacks generated by the CLI login flow. */
function safeCliRedirect(value: string | null): string | undefined {
  if (value == null || value === "") return undefined;
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const safe = local && url.protocol === "http:" && url.username === "" && url.password === "" && url.port !== "";
    return safe ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the configured Google OAuth callback URL. */
function callbackUrl(baseUrl: string): string {
  return `${baseUrl}/auth/callback/google`;
}

/** Checks the decoded OAuth state token shape. */
function isOAuthState(value: unknown): value is OAuthState {
  return (
    isRecord(value) &&
    value.version === SESSION_VERSION &&
    typeof value.returnTo === "string" &&
    typeof value.nonce === "string" &&
    typeof value.expiresAt === "number" &&
    (value.cliRedirect == null || typeof value.cliRedirect === "string")
  );
}

/** Checks the decoded session token payload shape. */
function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    isRecord(value) &&
    value.version === SESSION_VERSION &&
    value.provider === "google" &&
    typeof value.issuedAt === "number" &&
    typeof value.expiresAt === "number" &&
    isRecord(value.user) &&
    typeof value.user.id === "string" &&
    typeof value.user.email === "string"
  );
}

/** Returns the current Unix timestamp in seconds. */
function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Generates a base64url nonce for OAuth state and ID-token binding. */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
