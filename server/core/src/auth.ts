/**
 * The auth service — one implementation per auth mode (built-in Google OAuth, or
 * Cloudflare Access asserting identity via the Cf-Access-Jwt-Assertion header) — and
 * the three signed HMAC token kinds it mints: session tokens (browser cookie or CLI
 * bearer, session TTL), OAuth state tokens (10-minute, browser-bound), and
 * project-access tokens ("handoff": ~60s, query-string form; "cookie": session-length
 * redeemed form).
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { base64UrlToBytes, bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { errorMessage } from "../../../shared/src/util/errors";
import { parseJson } from "../../../shared/src/util/json";
import { accessGroupMatches } from "./access";
import { verifyCloudflareAccessToken } from "./cloudflare-jwt";
import { ServerConfig, type AuthConfig, type CloudflareAccessAuthConfig, type OAuthAuthConfig } from "./config";
import {
  clearSessionCookie,
  cookieToken,
  oauthStateCookie,
  oauthStateToken,
  sessionCookie,
  STATE_TTL_SECONDS,
} from "./cookies";
import { verifyGoogleIdToken, type GoogleIdTokenClaims } from "./google-jwt";
import { timingSafeEqual } from "./tokens";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Bumping this invalidates every outstanding session and state token. */
const SESSION_VERSION = 1;
/** Versioned separately from sessions: bumping this deliberately invalidates every
 * outstanding project-access token (handoff and cookie) without logging anyone out or
 * breaking CLI bearer tokens. */
const PROJECT_ACCESS_VERSION = 1;
/** Handoff tokens ride redirect query strings (which land in proxy logs), so they live seconds. */
const HANDOFF_TTL_SECONDS = 60;
const REDIRECT_MAX_LENGTH = 2048;

/** The authenticated identity attached to sessions and API requests. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly picture?: string;
}

/** The user object embedded in every session-token payload. */
const AuthUserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
});

/** Payload of a session token (browser cookie or CLI bearer). */
const SessionPayloadSchema = Schema.Struct({
  version: Schema.Literal(SESSION_VERSION),
  provider: Schema.Literal("google", "cloudflare-access"),
  user: AuthUserSchema,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
});
type SessionPayload = typeof SessionPayloadSchema.Type;

/** Payload of the OAuth state token that rides the login redirect round-trip. */
const OAuthStateSchema = Schema.Struct({
  version: Schema.Literal(SESSION_VERSION),
  returnTo: Schema.String,
  cliRedirect: Schema.optional(Schema.String),
  nonce: Schema.String,
  expiresAt: Schema.Number,
});
type OAuthState = typeof OAuthStateSchema.Type;

/**
 * `handoff` tokens ride the redirect from the app host to the content host and live for
 * seconds (they pass through query strings, which land in proxy logs). `cookie` tokens are
 * the redeemed form stored in the path-scoped content cookie and live as long as a session.
 */
export type ProjectAccessUse = "handoff" | "cookie";

/** Payload of a project-access token. `project` is the identity; `scope` is the URL path
 * the redeemed cookie is scoped to, kept as a separate claim (today always `/<project>`)
 * so a future homepage alias can scope a token to `/` without a format change. */
const ProjectAccessPayloadSchema = Schema.Struct({
  version: Schema.Literal(PROJECT_ACCESS_VERSION),
  kind: Schema.Literal("project-access"),
  use: Schema.Literal("handoff", "cookie"),
  project: Schema.String,
  scope: Schema.String,
  email: Schema.String,
  expiresAt: Schema.Number,
});
type ProjectAccessPayload = typeof ProjectAccessPayloadSchema.Type;

/** Google's token-endpoint response shape, as much of it as the exchange needs. */
interface GoogleTokenResponse {
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

/** Auth failure; `status` becomes the HTTP response status. */
export class AuthError extends Data.TaggedError("AuthError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The auth service contract. */
export interface AuthShape {
  /** Resolves the bearer- or cookie-authenticated user, or null when absent/invalid. */
  readonly currentUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser | null, AuthError>;
  /** Like currentUser but bearer-token only (API calls) and 401 when unauthenticated. */
  readonly requireApiUser: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUser, AuthError>;
  /** Starts the Google OAuth flow: sets the state cookie and redirects to Google. */
  readonly login: (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    baseUrl: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError>;
  /** Completes the OAuth flow: verifies state, exchanges the code, sets the session cookie. */
  readonly callback: (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    baseUrl: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError>;
  /** Clears the session cookie and redirects home. */
  readonly logout: (baseUrl: string) => HttpServerResponse.HttpServerResponse;
  /** Signs a token granting one user read access to one project. */
  readonly issueProjectAccessToken: (
    project: string,
    user: AuthUser,
    use: ProjectAccessUse,
  ) => Effect.Effect<string, AuthError>;
  /** Verifies a project-access token against the expected project and use. */
  readonly verifyProjectAccessToken: (
    token: string,
    project: string,
    use: ProjectAccessUse,
  ) => Effect.Effect<AuthUser | null, AuthError>;
}

/** Service tag for the auth service. */
export class Auth extends Context.Tag("@scratchwork/server/Auth")<Auth, AuthShape>() {}

/** Provides the configured auth mode's service from server config. */
export const AuthLive: Layer.Layer<Auth, never, ServerConfig> = Layer.effect(
  Auth,
  Effect.map(ServerConfig, (config) => makeAuth(config.auth)),
);

/** Creates the auth service implementation for the configured mode. */
export function makeAuth(config: AuthConfig): AuthShape {
  return config.mode === "cloudflare-access" ? makeCloudflareAccessAuth(config) : makeGoogleAuth(config);
}

/** Creates the auth service implementation over built-in Google OAuth. */
function makeGoogleAuth(config: OAuthAuthConfig): AuthShape {
  return Auth.of({
    currentUser: (request) =>
      Effect.gen(function* () {
        const token = bearerToken(request) ?? cookieToken(request);
        if (token == null) return null;
        return yield* verifySessionToken(token, config).pipe(Effect.orElseSucceed(() => null));
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

        const state = yield* verifySignedValue(stateToken, config.sessionSecret, OAuthStateSchema);
        if (state.expiresAt < epochSeconds()) {
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

    ...projectAccessTokenMethods(config),
  });
}

/** The Cloudflare Access request header carrying the edge-verified identity assertion. */
const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
/** The client-supplied header the CLI sends its relayed Access JWT in. Cloudflare's edge
 * accepts it as an Access credential; the server accepts it too so requests that reach
 * the origin without passing the edge (grey-clouded origin, local testing) still verify.
 * Verification is identical to the assertion header, so this adds no trust. */
const CF_ACCESS_TOKEN_HEADER = "cf-access-token";

/** The raw Access JWT presented on a request: the edge-injected assertion header first,
 * then the CLI's relayed header. Null when neither is present. */
function presentedAccessToken(request: HttpServerRequest.HttpServerRequest): string | null {
  for (const header of [CF_ACCESS_JWT_HEADER, CF_ACCESS_TOKEN_HEADER]) {
    const value = request.headers[header];
    if (value != null && value !== "") return value;
  }
  return null;
}

/**
 * Creates the auth service implementation over Cloudflare Access. The edge authenticates
 * every request before it reaches the server and injects a signed assertion header; the
 * server verifies it against the team's JWKS and the application AUD tag, so a directly
 * reached origin cannot be fooled by a forged header. Sessions minted at /auth/login keep
 * the CLI bearer flow working — the login redirect also relays the verified Access JWT so
 * the CLI can pass the edge on API requests — and there is no OAuth redirect dance and no
 * session cookie.
 */
function makeCloudflareAccessAuth(config: CloudflareAccessAuthConfig): AuthShape {
  /** The identity asserted by the Access header: null when the header is absent, an
   * AuthError when it is present but does not verify. The allow-list is applied here so
   * every entry point shares the same gate. */
  const assertedUser = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthUser | null, AuthError> =>
    Effect.gen(function* () {
      const token = presentedAccessToken(request);
      if (token == null) return null;
      const claims = yield* verifyCloudflareAccessToken(token, {
        teamDomain: config.teamDomain,
        audience: config.audience,
      }).pipe(
        Effect.mapError((cause) => new AuthError({ status: 401, message: cause.message, cause })),
      );
      const email = claims.email.toLowerCase();
      // sub is Cloudflare's stable user UUID; tokens without one fall back to the email.
      const user: AuthUser = {
        id: typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : email,
        email,
      };
      return allowedUser(user, config) ? user : null;
    });

  return Auth.of({
    currentUser: (request) =>
      Effect.gen(function* () {
        const token = bearerToken(request) ?? cookieToken(request);
        if (token != null) {
          const user = yield* verifySessionToken(token, config).pipe(Effect.orElseSucceed(() => null));
          if (user != null) return user;
        }
        return yield* assertedUser(request).pipe(Effect.orElseSucceed(() => null));
      }),

    requireApiUser: (request) =>
      Effect.gen(function* () {
        const token = bearerToken(request);
        const sessionUser = token == null ? null : yield* verifySessionToken(token, config);
        if (sessionUser != null) return sessionUser;
        const user = yield* assertedUser(request);
        if (user == null) {
          return yield* Effect.fail(new AuthError({ status: 401, message: "Authentication required" }));
        }
        return user;
      }),

    // Cloudflare already authenticated the browser before this request arrived, so login
    // just converts the asserted identity into a redirect — with a bearer token for the
    // CLI loopback, or straight back into the app for a browser.
    login: (request, url, baseUrl) =>
      Effect.gen(function* () {
        const accessToken = presentedAccessToken(request);
        if (accessToken == null) {
          return yield* Effect.fail(
            new AuthError({
              status: 401,
              message:
                "Cloudflare Access did not authenticate this request (no Cf-Access-Jwt-Assertion header). This server expects to run behind a Cloudflare Access application.",
            }),
          );
        }
        const user = yield* assertedUser(request);
        if (user == null) {
          return yield* Effect.fail(new AuthError({ status: 403, message: "Account is not allowed on this server" }));
        }

        const cliRedirect = safeCliRedirect(url.searchParams.get("cli_redirect"));
        if (cliRedirect != null) {
          const token = yield* createSessionToken(user, config);
          const redirectUrl = new URL(cliRedirect);
          redirectUrl.searchParams.set("token", token);
          redirectUrl.searchParams.set("server", baseUrl);
          redirectUrl.searchParams.set("email", user.email);
          // Relay the verified Access JWT so the CLI can present it back (as
          // cf-access-token) and pass Cloudflare's edge on API requests. It rides the
          // loopback query string exactly like the bearer token above — same exposure.
          redirectUrl.searchParams.set("cf_token", accessToken);
          return HttpServerResponse.redirect(redirectUrl, { status: 302 });
        }
        return HttpServerResponse.redirect(safeReturnTo(url.searchParams.get("returnTo")) ?? "/", { status: 302 });
      }),

    callback: () =>
      Effect.fail(new AuthError({ status: 404, message: "This server uses Cloudflare Access; there is no OAuth callback" })),

    // Cloudflare's edge handles /cdn-cgi/access/logout on the protected domain and ends
    // the Access session; the server never sees that request. Clear the scratchwork
    // session cookie too so a stale one cannot outlive the Access session.
    logout: (baseUrl) =>
      HttpServerResponse.redirect("/cdn-cgi/access/logout", {
        status: 302,
        headers: {
          "set-cookie": clearSessionCookie(baseUrl),
        },
      }),

    ...projectAccessTokenMethods(config),
  });
}

/** The project-access token methods every auth mode shares: HMAC tokens signed with the
 * session secret, carrying the viewer's email through the app-to-content-host handoff. */
function projectAccessTokenMethods(
  config: AuthConfig,
): Pick<AuthShape, "issueProjectAccessToken" | "verifyProjectAccessToken"> {
  return {
    issueProjectAccessToken: (project, user, use) =>
      signValue(
        {
          version: PROJECT_ACCESS_VERSION,
          kind: "project-access",
          use,
          project,
          scope: `/${project}`,
          email: user.email,
          expiresAt: epochSeconds() + (use === "handoff" ? HANDOFF_TTL_SECONDS : config.sessionTtlSeconds),
        } satisfies ProjectAccessPayload,
        config.sessionSecret,
      ),

    verifyProjectAccessToken: (token, project, use) =>
      Effect.gen(function* () {
        const payload = yield* verifySignedValue(token, config.sessionSecret, ProjectAccessPayloadSchema);
        if (
          payload.use !== use ||
          payload.expiresAt < epochSeconds() ||
          payload.project !== project ||
          payload.scope !== `/${project}`
        ) {
          return null;
        }
        const user = { id: payload.email, email: payload.email };
        return allowedUser(user, config) ? user : null;
      }),
  };
}

/** Signs a portable session token for browser cookies and CLI bearer auth. */
export function createSessionToken(
  user: AuthUser,
  config: AuthConfig,
): Effect.Effect<string, AuthError> {
  const issuedAt = epochSeconds();
  return signValue(
    {
      version: SESSION_VERSION,
      provider: config.mode === "cloudflare-access" ? "cloudflare-access" : "google",
      user,
      issuedAt,
      expiresAt: issuedAt + config.sessionTtlSeconds,
    } satisfies SessionPayload,
    config.sessionSecret,
  );
}

/** Verifies one signed session token and applies current allow-list rules. */
function verifySessionToken(
  token: string,
  config: AuthConfig,
): Effect.Effect<AuthUser | null, AuthError> {
  return Effect.gen(function* () {
    const payload = yield* verifySignedValue(token, config.sessionSecret, SessionPayloadSchema);
    if (payload.expiresAt < epochSeconds()) return null;
    if (!allowedUser(payload.user, config)) return null;
    return payload.user;
  });
}

/** Exchanges a Google OAuth code and verifies the returned ID token. */
function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  nonce: string,
  config: OAuthAuthConfig,
): Effect.Effect<AuthUser, AuthError> {
  return Effect.gen(function* () {
    const { ok, json } = yield* Effect.tryPromise({
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
        return { ok: response.ok, json };
      },
      catch: (cause) => new AuthError({ status: 500, message: errorMessage(cause) }),
    });
    if (!ok || json?.id_token == null) {
      return yield* Effect.fail(
        new AuthError({
          status: 401,
          message: json?.error_description ?? json?.error ?? "Google token exchange failed",
        }),
      );
    }

    const claims = yield* verifyGoogleIdToken(json.id_token, {
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
  config: AuthConfig,
): AuthUser | null {
  const user: AuthUser = {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
  return allowedUser(user, config) ? user : null;
}

/** Checks a user (from Google claims or a verified token payload) against the allow lists. */
function allowedUser(user: AuthUser, config: AuthConfig): boolean {
  return accessGroupMatches(config.allowedUsers, user);
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

/** Verifies a compact HMAC token and decodes its payload against the expected schema. */
function verifySignedValue<A, I>(
  token: string,
  secret: string,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<A, AuthError> {
  return Effect.tryPromise({
    try: async () => {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) throw new Error("invalid token");
      const expected = await hmac(payload, secret);
      if (!timingSafeEqual(signature, expected)) throw new Error("invalid token signature");
      const bytes = base64UrlToBytes(payload);
      if (bytes == null) throw new Error("invalid token payload");
      return parseJson(new TextDecoder().decode(bytes));
    },
    catch: () => new AuthError({ status: 401, message: "Invalid auth token" }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknown(schema)(value).pipe(
        Effect.mapError(() => new AuthError({ status: 401, message: "Invalid auth token" })),
      ),
    ),
  );
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

/** Accepts only loopback HTTP callbacks generated by the CLI login flow.
 * Deliberately narrower than shared isLoopbackHost: RFC 8252 limits OAuth
 * loopback redirects to 127.0.0.1 / ::1 / localhost. */
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
