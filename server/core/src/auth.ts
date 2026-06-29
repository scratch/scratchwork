import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig, type AuthConfig } from "./config";

const COOKIE_NAME = "scratchwork_session";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_VERSION = 1;
const STATE_TTL_SECONDS = 10 * 60;

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
  readonly expiresAt: number;
}

interface GoogleTokenResponse {
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GoogleIdTokenClaims {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly name?: string;
  readonly picture?: string;
  readonly exp?: number;
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly status: number;
  readonly message: string;
}> {}

export interface AuthShape {
  readonly enabled: boolean;
  readonly currentUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  readonly requireUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  readonly login: (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    baseUrl: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError>;
  readonly callback: (
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

export function makeAuth(config: AuthConfig): AuthShape {
  if (config._tag === "Disabled") {
    return Auth.of({
      enabled: false,
      currentUser: () => Effect.succeed(null),
      requireUser: () => Effect.succeed(null),
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

    login: (_request, url, baseUrl) =>
      Effect.gen(function* () {
        const returnTo = safeReturnTo(url.searchParams.get("returnTo")) ?? "/";
        const cliRedirect = safeCliRedirect(url.searchParams.get("cli_redirect"));
        const state = yield* signValue(
          {
            version: SESSION_VERSION,
            returnTo,
            cliRedirect,
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
        authUrl.searchParams.set("prompt", "select_account");
        return HttpServerResponse.redirect(authUrl, { status: 302 });
      }),

    callback: (url, baseUrl) =>
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

        const state = yield* verifySignedValue<OAuthState>(stateToken, config.sessionSecret);
        if (!isOAuthState(state) || state.expiresAt < epochSeconds()) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Invalid or expired OAuth state" }));
        }

        const user = yield* exchangeGoogleCode(code, callbackUrl(baseUrl), config);
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

function verifySessionTokenFromRequest(
  request: HttpServerRequest.HttpServerRequest,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<AuthUser | null, AuthError> {
  const token = bearerToken(request) ?? cookieToken(request);
  return token == null ? Effect.succeed(null) : verifySessionToken(token, config);
}

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

function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): Effect.Effect<AuthUser, AuthError> {
  return Effect.tryPromise({
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
      const claims = decodeGoogleIdToken(json.id_token);
      const user = userFromClaims(claims, config);
      if (user == null) {
        throw new AuthError({ status: 403, message: "Google account is not allowed" });
      }
      return user;
    },
    catch: (cause) =>
      cause instanceof AuthError
        ? cause
        : new AuthError({ status: 500, message: errorMessage(cause) }),
  });
}

function userFromClaims(
  claims: GoogleIdTokenClaims,
  config: Extract<AuthConfig, { readonly _tag: "Google" }>,
): AuthUser | null {
  if (claims.aud !== config.clientId) return null;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
  if (typeof claims.exp !== "number" || claims.exp < epochSeconds()) return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  if (typeof claims.email !== "string" || claims.email === "") return null;
  if (claims.email_verified !== true && claims.email_verified !== "true") return null;

  const user: AuthUser = {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
  return allowedUser(user, config) ? user : null;
}

function allowedUser(user: AuthUser, config: Extract<AuthConfig, { readonly _tag: "Google" }>): boolean {
  if (config.allowedEmails.size === 0 && config.allowedDomains.size === 0) return true;
  if (config.allowedEmails.has(user.email.toLowerCase())) return true;
  const domain = user.email.split("@")[1]?.toLowerCase();
  return domain != null && config.allowedDomains.has(domain);
}

function decodeGoogleIdToken(token: string): GoogleIdTokenClaims {
  const [, payload] = token.split(".");
  if (payload == null) return {};
  return parseJson(new TextDecoder().decode(base64UrlToBytes(payload))) as GoogleIdTokenClaims;
}

function signValue(value: unknown, secret: string): Effect.Effect<string, AuthError> {
  return Effect.tryPromise({
    try: async () => {
      const payload = base64Url(new TextEncoder().encode(JSON.stringify(value)));
      const signature = await hmac(payload, secret);
      return `${payload}.${signature}`;
    },
    catch: (cause) => new AuthError({ status: 500, message: `Could not sign auth token: ${errorMessage(cause)}` }),
  });
}

function verifySignedValue<A>(token: string, secret: string): Effect.Effect<A, AuthError> {
  return Effect.tryPromise({
    try: async () => {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) throw new Error("invalid token");
      const expected = await hmac(payload, secret);
      if (!timingSafeEqual(signature, expected)) throw new Error("invalid token signature");
      return parseJson(new TextDecoder().decode(base64UrlToBytes(payload))) as A;
    },
    catch: () => new AuthError({ status: 401, message: "Invalid auth token" }),
  });
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function bearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (header == null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function cookieToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const header = request.headers.cookie;
  if (header == null) return undefined;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function sessionCookie(token: string, baseUrl: string, ttlSeconds: number): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
}

function clearSessionCookie(baseUrl: string): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secureCookie(baseUrl),
  ].filter(Boolean).join("; ");
}

function secureCookie(baseUrl: string): string {
  return baseUrl.startsWith("https://") ? "Secure" : "";
}

function safeReturnTo(value: string | null): string | null {
  if (value == null || value === "") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\0")) return null;
  return value;
}

function safeCliRedirect(value: string | null): string | undefined {
  if (value == null || value === "") return undefined;
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return local && (url.protocol === "http:" || url.protocol === "https:") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function callbackUrl(baseUrl: string): string {
  return `${baseUrl}/auth/callback/google`;
}

function isOAuthState(value: unknown): value is OAuthState {
  return (
    isRecord(value) &&
    value.version === SESSION_VERSION &&
    typeof value.returnTo === "string" &&
    typeof value.expiresAt === "number" &&
    (value.cliRedirect == null || typeof value.cliRedirect === "string")
  );
}

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

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(triplet >> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[triplet & 63];
  }
  return output;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((padded.length * 3) / 4) - padding);
  let byteIndex = 0;
  for (let index = 0; index < padded.length; index += 4) {
    const a = alphabet.indexOf(padded[index]);
    const b = alphabet.indexOf(padded[index + 1]);
    const c = padded[index + 2] === "=" ? 0 : alphabet.indexOf(padded[index + 2]);
    const d = padded[index + 3] === "=" ? 0 : alphabet.indexOf(padded[index + 3]);
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 16) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 8) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = triplet & 255;
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}
