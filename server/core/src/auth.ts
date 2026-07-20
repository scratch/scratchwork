/**
 * The auth service — one implementation per auth mode (built-in Google OAuth, or
 * Cloudflare Access asserting identity via the Cf-Access-Jwt-Assertion header) — and
 * the four signed HMAC token kinds it mints: session tokens (browser cookie or CLI
 * bearer, session TTL), OAuth state tokens (10-minute, browser-bound, cookie-only —
 * they carry the PKCE verifier, which must never transit the provider), CLI
 * authorization codes (~60s one-time codes delivered to the CLI's loopback callback
 * and exchanged for a session token at /auth/cli/token), and project-access tokens
 * ("handoff": ~60s, query-string form; "cookie": session-length redeemed form).
 */
import * as Cookies from "@effect/platform/Cookies";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { sha256Base64Url } from "../../../shared/src/crypto/digest";
import { errorMessage } from "../../../shared/src/util/errors";
import { accessGroupMatches } from "./access";
import * as AuthCrypto from "./auth-crypto";
import { verifyCloudflareAccessToken } from "./cloudflare-jwt";
import { ServerConfig, type AuthConfig, type CloudflareAccessAuthConfig, type OAuthAuthConfig } from "./config";
import {
  clearOauthStateCookie,
  clearSessionCookie,
  cookieToken,
  oauthStateCookie,
  oauthStateToken,
  sessionCookie,
  STATE_TTL_SECONDS,
} from "./cookies";
import {
  postAuthorizationCodeGrant,
  verifyGoogleIdToken,
  type GoogleIdTokenClaims,
} from "./google-jwt";
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
/** CLI authorization codes ride the loopback redirect query string, so they live seconds
 * and are additionally one-time: redemption is recorded in PrimitiveDb by the exchange
 * route, so a replayed code fails even inside this window. */
const CLI_CODE_TTL_SECONDS = 60;
/** PKCE S256 challenges and verifiers are 43-128 base64url characters (RFC 7636 §4). */
const PKCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CLI_STATE_MAX_LENGTH = 256;
const REDIRECT_MAX_LENGTH = 2048;

/** The authenticated identity attached to sessions and API requests. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly picture?: string;
}

/** Seconds-since-epoch claim. JSON can smuggle `1e999`, which parses to
 * Infinity and would make a token eternal; finite() closes that. */
const EpochSecondsSchema = Schema.Number.pipe(Schema.finite());

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
  kind: Schema.Literal("session"),
  provider: Schema.Literal("google", "cloudflare-access"),
  user: AuthUserSchema,
  issuedAt: EpochSecondsSchema,
  expiresAt: EpochSecondsSchema,
});
type SessionPayload = typeof SessionPayloadSchema.Type;

/** Payload of the OAuth state token. It lives only in the browser-bound state cookie —
 * never in the redirect's `state` parameter, which carries just the opaque random
 * `state` value echoed by the provider — because the payload holds the PKCE
 * `codeVerifier`, which the provider must never see. `cliState` and
 * `cliCodeChallenge` are present exactly when `cliRedirect` is: they bind the CLI
 * leg of the flow to the CLI instance that started it. */
const OAuthStateSchema = Schema.Struct({
  version: Schema.Literal(SESSION_VERSION),
  kind: Schema.Literal("oauth-state"),
  state: Schema.String,
  nonce: Schema.String,
  codeVerifier: Schema.String,
  returnTo: Schema.String,
  cliRedirect: Schema.optional(Schema.String),
  cliState: Schema.optional(Schema.String),
  cliCodeChallenge: Schema.optional(Schema.String),
  expiresAt: EpochSecondsSchema,
});
type OAuthState = typeof OAuthStateSchema.Type;

/** Payload of a CLI authorization code: the short-lived one-time token the browser
 * leg delivers to the CLI's loopback callback. It never grants access by itself —
 * the CLI exchanges it at /auth/cli/token by proving possession of the PKCE
 * verifier (`codeChallenge` is its S256 digest) from the exact `redirectUri` the
 * code was delivered to. `id` keys the one-time redemption record. */
const CliCodePayloadSchema = Schema.Struct({
  version: Schema.Literal(SESSION_VERSION),
  kind: Schema.Literal("cli-code"),
  id: Schema.String,
  user: AuthUserSchema,
  provider: Schema.Literal("google", "cloudflare-access"),
  codeChallenge: Schema.String,
  redirectUri: Schema.String,
  /** AES-GCM ciphertext of the relayed Cloudflare Access JWT. Authorization codes
   * ride a loopback query string, so bearer credentials must never appear in their
   * signed-but-readable payload. */
  encryptedCfToken: Schema.optional(Schema.String),
  expiresAt: EpochSecondsSchema,
});

/** The decoded CLI authorization-code payload. */
export type CliCodePayload = typeof CliCodePayloadSchema.Type;

/** The CLI login parameters accepted by /auth/login: all three present or none. */
interface CliLoginRequest {
  readonly cliRedirect: string;
  readonly cliState: string;
  readonly cliCodeChallenge: string;
}

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
  expiresAt: EpochSecondsSchema,
});
type ProjectAccessPayload = typeof ProjectAccessPayloadSchema.Type;

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
        const cli = yield* readCliLoginRequest(url);
        const state = randomNonce();
        const nonce = randomNonce();
        const codeVerifier = randomVerifier();
        const codeChallenge = yield* sha256Challenge(codeVerifier);
        const stateToken = yield* signValue(
          {
            version: SESSION_VERSION,
            kind: "oauth-state",
            state,
            nonce,
            codeVerifier,
            returnTo,
            ...(cli ?? {}),
            expiresAt: epochSeconds() + STATE_TTL_SECONDS,
          } satisfies OAuthState,
          config.sessionSecret,
        );

        const authUrl = new URL(providerEndpoints(config).authorizeUrl);
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", callbackUrl(baseUrl));
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("nonce", nonce);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("prompt", "select_account");
        return HttpServerResponse.redirect(authUrl, {
          status: 302,
          headers: {
            "set-cookie": oauthStateCookie(stateToken, baseUrl),
          },
        });
      }),

    callback: (request, url, baseUrl) =>
      Effect.gen(function* () {
        // The state transaction binds every branch, including provider denial: the
        // cookie must verify and the provider-echoed state parameter must match it
        // before anything — even an error — is acted on.
        const stateParam = url.searchParams.get("state");
        const stateCookie = oauthStateToken(request, baseUrl);
        if (!stateParam || stateCookie == null) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Missing OAuth callback parameters" }));
        }
        const state = yield* verifySignedValue(stateCookie, config.sessionSecret, OAuthStateSchema);
        if (state.expiresAt <= epochSeconds() || !timingSafeEqual(stateParam, state.state)) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Invalid or expired OAuth state" }));
        }

        const error = url.searchParams.get("error");
        if (error != null) {
          // A CLI-initiated flow learns of the denial through its loopback callback,
          // per RFC 8252; a browser flow gets the error page.
          if (state.cliRedirect != null && state.cliState != null) {
            return cliCallbackRedirect(state.cliRedirect, state.cliState, { error }, baseUrl);
          }
          return yield* Effect.fail(
            new AuthError({ status: 400, message: `Google OAuth failed: ${sanitizeProviderError(error)}` }),
          );
        }

        const code = url.searchParams.get("code");
        if (!code) {
          return yield* Effect.fail(new AuthError({ status: 400, message: "Missing OAuth callback parameters" }));
        }

        const user = yield* exchangeGoogleCode(code, callbackUrl(baseUrl), state.nonce, state.codeVerifier, config);

        if (state.cliRedirect != null && state.cliState != null && state.cliCodeChallenge != null) {
          const cliCode = yield* issueCliAuthorizationCode(user, {
            provider: "google",
            codeChallenge: state.cliCodeChallenge,
            redirectUri: state.cliRedirect,
          }, config);
          return cliCallbackRedirect(state.cliRedirect, state.cliState, { code: cliCode }, baseUrl);
        }

        const token = yield* createSessionToken(user, config);
        // Two Set-Cookie headers (the session, and the now-spent state cookie's
        // clearing) must stay separate headers; the cookies option does that where
        // a headers record would comma-join them.
        return HttpServerResponse.redirect(state.returnTo, {
          status: 302,
          cookies: Cookies.fromSetCookie([
            sessionCookie(token, baseUrl, config.sessionTtlSeconds),
            clearOauthStateCookie(baseUrl),
          ]),
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
        jwks: config.localJwks,
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
        // A bearer that fails verification (e.g. signed with a rotated secret) is treated
        // as absent rather than fatal: the Access assertion is an independent credential
        // and may still authenticate the request.
        const token = bearerToken(request);
        const sessionUser =
          token == null
            ? null
            : yield* verifySessionToken(token, config).pipe(Effect.orElseSucceed(() => null));
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

        const cli = yield* readCliLoginRequest(url);
        if (cli != null) {
          // The loopback receives only a short-lived one-time code. The verified
          // Access JWT is encrypted before it enters the otherwise-readable signed
          // payload, then decrypted only by the back-channel exchange.
          const code = yield* issueCliAuthorizationCode(user, {
            provider: "cloudflare-access",
            codeChallenge: cli.cliCodeChallenge,
            redirectUri: cli.cliRedirect,
            cfToken: accessToken,
          }, config);
          return cliCallbackRedirect(cli.cliRedirect, cli.cliState, { code }, baseUrl);
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
          payload.expiresAt <= epochSeconds() ||
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
      kind: "session",
      provider: config.mode === "cloudflare-access" ? "cloudflare-access" : "google",
      user,
      issuedAt,
      expiresAt: issuedAt + config.sessionTtlSeconds,
    } satisfies SessionPayload,
    config.sessionSecret,
  );
}

/** Reads and validates the CLI login parameters from /auth/login. A CLI-initiated
 * login must bind its whole transaction up front: the loopback redirect, the CLI's
 * own state echo, and the PKCE S256 challenge its code will be locked to. An
 * invalid loopback redirect is treated as absent (a plain browser login); a valid
 * one missing its companions is rejected so a downlevel CLI cannot silently start
 * an unbound flow. */
function readCliLoginRequest(url: URL): Effect.Effect<CliLoginRequest | undefined, AuthError> {
  const cliRedirect = safeCliRedirect(url.searchParams.get("cli_redirect"));
  if (cliRedirect == null) return Effect.succeed(undefined);
  const cliState = url.searchParams.get("cli_state");
  const cliCodeChallenge = url.searchParams.get("cli_code_challenge");
  if (
    cliState == null || cliState === "" || cliState.length > CLI_STATE_MAX_LENGTH ||
    cliCodeChallenge == null || !PKCE_PATTERN.test(cliCodeChallenge)
  ) {
    return Effect.fail(
      new AuthError({
        status: 400,
        message: "CLI login requires cli_state and a cli_code_challenge (PKCE S256). Update the scratchwork CLI.",
      }),
    );
  }
  return Effect.succeed({ cliRedirect, cliState, cliCodeChallenge });
}

/** Builds the redirect that completes (or denies) a CLI login at its loopback
 * callback, echoing the CLI's state and clearing the spent browser state cookie. */
function cliCallbackRedirect(
  cliRedirect: string,
  cliState: string,
  result: { readonly code: string } | { readonly error: string },
  baseUrl: string,
): HttpServerResponse.HttpServerResponse {
  const redirectUrl = new URL(cliRedirect);
  if ("code" in result) {
    redirectUrl.searchParams.set("code", result.code);
  } else {
    redirectUrl.searchParams.set("error", sanitizeProviderError(result.error));
  }
  redirectUrl.searchParams.set("state", cliState);
  return HttpServerResponse.redirect(redirectUrl, {
    status: 302,
    headers: { "set-cookie": clearOauthStateCookie(baseUrl) },
  });
}

/** Reduces a provider-supplied error code to a safe token before echoing it. */
function sanitizeProviderError(error: string): string {
  return /^[a-z0-9_]{1,64}$/i.test(error) ? error : "provider_error";
}

/** Signs a short-lived one-time CLI authorization code bound to a PKCE challenge
 * and the exact loopback redirect it is about to be delivered to. */
export function issueCliAuthorizationCode(
  user: AuthUser,
  binding: {
    readonly provider: "google" | "cloudflare-access";
    readonly codeChallenge: string;
    readonly redirectUri: string;
    readonly cfToken?: string;
  },
  config: AuthConfig,
): Effect.Effect<string, AuthError> {
  return Effect.gen(function* () {
    const encryptedCfToken = binding.cfToken == null
      ? undefined
      : yield* encryptCredential(binding.cfToken, config.sessionSecret);
    return yield* signValue(
      {
        version: SESSION_VERSION,
        kind: "cli-code",
        id: randomNonce(),
        user,
        provider: binding.provider,
        codeChallenge: binding.codeChallenge,
        redirectUri: binding.redirectUri,
        encryptedCfToken,
        expiresAt: epochSeconds() + CLI_CODE_TTL_SECONDS,
      } satisfies CliCodePayload,
      config.sessionSecret,
    );
  });
}

/** Verifies a CLI authorization code's signature, shape, and expiry. The one-time
 * redemption record and the PKCE/redirect binding checks are separate steps: the
 * exchange route burns the code id between the two, so a code is consumed by its
 * first redemption attempt whether or not that attempt proves possession. */
export function decodeCliAuthorizationCode(
  code: string,
  config: AuthConfig,
): Effect.Effect<CliCodePayload, AuthError> {
  return Effect.gen(function* () {
    const payload = yield* verifySignedValue(code, config.sessionSecret, CliCodePayloadSchema).pipe(
      Effect.mapError((cause) => new AuthError({ status: 400, message: "Invalid authorization code", cause })),
    );
    if (payload.expiresAt <= epochSeconds()) {
      return yield* Effect.fail(new AuthError({ status: 400, message: "Authorization code expired" }));
    }
    return payload;
  });
}

/** Returns the Access JWT protected inside a Cloudflare CLI code. The signed code
 * payload is visible to browser history and local request logs, so this decrypts an
 * authenticated ciphertext rather than reading a bearer credential in plaintext. */
export function decryptCliCloudflareToken(
  payload: CliCodePayload,
  config: AuthConfig,
): Effect.Effect<string | undefined, AuthError> {
  if (payload.encryptedCfToken == null) return Effect.succeed(undefined);
  return decryptCredential(payload.encryptedCfToken, config.sessionSecret);
}

/** Proves the exchange request comes from the CLI instance the code was issued to:
 * the presented verifier's S256 digest must equal the bound challenge and the
 * presented redirect URI must be the exact one the code was delivered to. The
 * allow-list is re-applied so removal revokes a code issued moments earlier. */
export function verifyCliCodeExchange(
  payload: CliCodePayload,
  codeVerifier: string,
  redirectUri: string,
  config: AuthConfig,
): Effect.Effect<AuthUser, AuthError> {
  return Effect.gen(function* () {
    if (!PKCE_PATTERN.test(codeVerifier)) {
      return yield* Effect.fail(new AuthError({ status: 400, message: "Invalid code verifier" }));
    }
    const challenge = yield* sha256Challenge(codeVerifier);
    if (!timingSafeEqual(challenge, payload.codeChallenge) || redirectUri !== payload.redirectUri) {
      return yield* Effect.fail(new AuthError({ status: 400, message: "Authorization code does not match this login" }));
    }
    if (!allowedUser(payload.user, config)) {
      return yield* Effect.fail(new AuthError({ status: 403, message: "Account is not allowed on this server" }));
    }
    return payload.user;
  });
}

/** Tolerated clock skew before a session token's issuedAt reads as forged. */
const ISSUED_AT_SKEW_SECONDS = 60;

/** Verifies one signed session token and applies current allow-list rules. A
 * token issued in the future (beyond clock skew) can only be a signing bug or
 * a crafted payload, so it is rejected rather than trusted until expiry. */
function verifySessionToken(
  token: string,
  config: AuthConfig,
): Effect.Effect<AuthUser | null, AuthError> {
  return Effect.gen(function* () {
    const payload = yield* verifySignedValue(token, config.sessionSecret, SessionPayloadSchema);
    if (payload.expiresAt <= epochSeconds()) return null;
    if (payload.issuedAt > epochSeconds() + ISSUED_AT_SKEW_SECONDS) return null;
    if (!allowedUser(payload.user, config)) return null;
    return payload.user;
  });
}

/** Encrypts one credential with a key derived from the session secret (AES-GCM in
 * the auth-crypto boundary module). */
function encryptCredential(value: string, secret: string): Effect.Effect<string, AuthError> {
  return Effect.tryPromise({
    try: () => AuthCrypto.encryptCredential(value, secret),
    catch: (cause) => new AuthError({ status: 500, message: "Could not protect Cloudflare Access credential", cause }),
  });
}

/** Decrypts a credential produced by encryptCredential. */
function decryptCredential(value: string, secret: string): Effect.Effect<string, AuthError> {
  return Effect.tryPromise({
    try: () => AuthCrypto.decryptCredential(value, secret),
    catch: (cause) => new AuthError({ status: 400, message: "Invalid authorization code", cause }),
  });
}

/** Exchanges a Google OAuth code (with the transaction's PKCE verifier) and verifies
 * the returned ID token. */
function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  nonce: string,
  codeVerifier: string,
  config: OAuthAuthConfig,
): Effect.Effect<AuthUser, AuthError> {
  return Effect.gen(function* () {
    const endpoints = providerEndpoints(config);
    const { ok, json } = yield* Effect.tryPromise({
      try: () => postAuthorizationCodeGrant(endpoints.tokenUrl, {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        codeVerifier,
        redirectUri,
      }),
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
      jwksUrl: config.localEndpoints?.jwksUrl,
      expectedIssuer: config.localEndpoints?.issuer,
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

/** The authorization-server endpoints for this configuration: the loopback-gated
 * local test provider when configured, otherwise Google. */
function providerEndpoints(config: OAuthAuthConfig): { readonly authorizeUrl: string; readonly tokenUrl: string } {
  return config.localEndpoints ?? { authorizeUrl: GOOGLE_AUTHORIZE_URL, tokenUrl: GOOGLE_TOKEN_URL };
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
  return Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value))),
      catch: (cause) => new AuthError({ status: 500, message: `Could not sign auth token: ${errorMessage(cause)}` }),
    });
    const signature = yield* Effect.tryPromise({
      try: () => AuthCrypto.hmacSha256Base64Url(payload, secret),
      catch: (cause) => new AuthError({ status: 500, message: `Could not sign auth token: ${errorMessage(cause)}` }),
    });
    return `${payload}.${signature}`;
  });
}

/** No minted token comes close to this; a bound keeps adversarial inputs from
 * buying an HMAC over megabytes. The largest legitimate payload is a CLI code
 * carrying an encrypted Cloudflare Access JWT (a few KB). */
const MAX_TOKEN_LENGTH = 16384;

/** Verifies a compact HMAC token and decodes its payload against the expected
 * schema. The parse is deliberately unforgiving: exactly two non-empty
 * segments, canonical base64url, and a strict decode that rejects excess
 * properties — a token that isn't byte-for-byte what the server mints is
 * invalid, never coerced. */
function verifySignedValue<A, I>(
  token: string,
  secret: string,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<A, AuthError> {
  const invalid = () => new AuthError({ status: 401, message: "Invalid auth token" });
  return Effect.gen(function* () {
    if (token.length > MAX_TOKEN_LENGTH) return yield* Effect.fail(invalid());
    const segments = token.split(".");
    if (segments.length !== 2) return yield* Effect.fail(invalid());
    const [payload, signature] = segments;
    if (!payload || !signature) return yield* Effect.fail(invalid());
    const expected = yield* Effect.tryPromise({
      try: () => AuthCrypto.hmacSha256Base64Url(payload, secret),
      catch: invalid,
    });
    if (!timingSafeEqual(signature, expected)) return yield* Effect.fail(invalid());
    const bytes = yield* Encoding.decodeBase64Url(payload).pipe(Either.mapLeft(invalid));
    // Canonicality: exactly one token string may exist per payload, however
    // tolerant the base64url decoder is of padding or alternate alphabets.
    if (Encoding.encodeBase64Url(bytes) !== payload) return yield* Effect.fail(invalid());
    return yield* Schema.decodeUnknown(Schema.parseJson(schema), { onExcessProperty: "error" })(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.mapError(invalid));
  });
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
  return Encoding.encodeBase64Url(bytes);
}

/** Generates a PKCE code verifier: 32 random bytes as 43 base64url characters. */
function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Encoding.encodeBase64Url(bytes);
}

/** Computes the base64url SHA-256 digest used for PKCE S256 challenges. */
function sha256Challenge(value: string): Effect.Effect<string, AuthError> {
  return Effect.tryPromise({
    try: () => sha256Base64Url(value),
    catch: (cause) => new AuthError({ status: 500, message: `Could not compute code challenge: ${errorMessage(cause)}` }),
  });
}
