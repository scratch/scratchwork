/**
 * The MCP OAuth 2.1 surface: the discovery metadata, dynamic client
 * registration (RFC 7591), authorize + consent, and token endpoints that let a
 * remote MCP client (Claude Code and friends) obtain an audience-bound bearer
 * token for the /mcp endpoint with the standard browser flow. These are
 * server-only fixed routes on the app origin — like /auth/* they never enter
 * the shared CLI contract (invariant 2) — and every route is enumerated in
 * MCP_OAUTH_ROUTES so the policy test matrix covers them (invariant 4).
 *
 * All token minting and verification lives in auth.ts behind the
 * signValue/verifySignedValue chokepoints (invariant 3); this module owns only
 * HTTP shaping: parameter validation, the consent page, and the RFC 6749/7591
 * error bodies.
 *
 * Trust boundaries (invariant 5): the four cookie-free endpoints (both
 * metadata documents, register, token) send `Access-Control-Allow-Origin: *`
 * — they never read an ambient credential, and browser-based MCP clients must
 * be able to fetch them. Authorize and consent read the session cookie and
 * therefore never relax CORS; the consent POST additionally requires the
 * same-origin check and a signed, user-bound transaction token, and the
 * consent page refuses framing.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FIGURE_SVG } from "@scratchwork/shared/assets/figure-svg.generated";
import { burnOneTimeCode } from "./api-routes.ts";
import {
  Auth,
  AuthError,
  createMcpAccessToken,
  createMcpConsentToken,
  createMcpRefreshToken,
  decodeMcpAuthorizationCode,
  isPkceValue,
  issueMcpAuthorizationCode,
  MCP_ACCESS_TTL_SECONDS,
  MCP_SCOPE,
  verifyMcpConsentToken,
  verifyMcpCodeExchange,
  verifyMcpRefreshToken,
  type AuthUser,
} from "./auth.ts";
import { ServerConfig } from "./config.ts";
import { PrimitiveDb, type PrimitiveDbConflict, type PrimitiveDbError } from "./db.ts";
import { escapeHtml } from "./error-pages.ts";
import { appBaseUrl, HttpError, rejectCrossOriginApiRequest, securityHeaders } from "./http.ts";
import { loadMcpClient, redirectUriMatches, registerMcpClient, type McpClient } from "./mcp-clients.ts";

/** Failures the OAuth routes may raise; page-shaped errors propagate to the
 * app's generic error rendering, RFC-shaped errors are built here. */
type McpOauthError = HttpError | AuthError | PrimitiveDbError | PrimitiveDbConflict;
type McpOauthServices = ServerConfig | Auth | PrimitiveDb;
type McpOauthEffect = Effect.Effect<HttpServerResponse.HttpServerResponse, McpOauthError, McpOauthServices>;

/** Namespace of one-time MCP authorization-code redemption records. */
const MCP_CODE_NAMESPACE = "mcp-code-redemptions";
/** Generous ceilings for the small JSON/form bodies these endpoints accept. */
const MAX_OAUTH_BODY_BYTES = 16 * 1024;
/** Cap on the client-supplied `state` value echoed back on redirects. */
const MAX_STATE_LENGTH = 512;

/** One MCP OAuth route's declared policy, enumerated by the policy matrix.
 * `auth` differs from the JSON API's modes: "none" (public metadata and the
 * credential-free registration endpoint), "session" (browser cookie), or
 * "code-exchange" (the presented code/refresh token is the credential). */
export interface McpOauthRoute {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly auth: "none" | "session" | "code-exchange";
  readonly mutation: boolean;
  readonly visibility: "metadata" | "client-registration" | "consent" | "oauth-token";
}

/** Every route this module dispatches, with its declared policy. */
export const MCP_OAUTH_ROUTES: ReadonlyArray<McpOauthRoute> = [
  { name: "protected-resource-metadata", method: "GET", path: "/.well-known/oauth-protected-resource", auth: "none", mutation: false, visibility: "metadata" },
  { name: "authorization-server-metadata", method: "GET", path: "/.well-known/oauth-authorization-server", auth: "none", mutation: false, visibility: "metadata" },
  { name: "oauth-register", method: "POST", path: "/oauth/register", auth: "none", mutation: true, visibility: "client-registration" },
  { name: "oauth-authorize", method: "GET", path: "/oauth/authorize", auth: "session", mutation: false, visibility: "consent" },
  { name: "oauth-consent", method: "POST", path: "/oauth/consent", auth: "session", mutation: true, visibility: "consent" },
  { name: "oauth-token", method: "POST", path: "/oauth/token", auth: "code-exchange", mutation: true, visibility: "oauth-token" },
];

/** The canonical MCP resource URL: the audience every access token is bound to. */
export function mcpResourceUrl(request: HttpServerRequest.HttpServerRequest, config: { readonly appUrl?: string }): string {
  return `${appBaseUrl(request, config)}/mcp`;
}

/** The 401 an unauthenticated /mcp request receives. The WWW-Authenticate
 * resource-metadata pointer is what starts a spec MCP client's OAuth flow. */
export function mcpUnauthorizedResponse(
  request: HttpServerRequest.HttpServerRequest,
  config: { readonly appUrl?: string },
): HttpServerResponse.HttpServerResponse {
  const metadataUrl = `${appBaseUrl(request, config)}/.well-known/oauth-protected-resource/mcp`;
  return HttpServerResponse.unsafeJson({ error: "Authentication required" }, {
    status: 401,
    headers: {
      ...securityHeaders(),
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`,
    },
  });
}

/** Dispatches one request against the MCP OAuth routes; null when the path is
 * not one of them (the caller falls through to API and content serving). */
export function dispatchMcpOauthRoute(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse | null, HttpError | AuthError, McpOauthServices> {
  return dispatchMcpOauthRouteRaw(request, url).pipe(
    // Storage failures never carry an OAuth meaning; they surface as the same
    // opaque 500 the API routes emit.
    Effect.catchTags({
      PrimitiveDbError: (cause) => Effect.fail(new HttpError({ status: 500, message: "Storage operation failed", cause })),
      PrimitiveDbConflict: (cause) => Effect.fail(new HttpError({ status: 500, message: "Storage operation failed", cause })),
    }),
  );
}

function dispatchMcpOauthRouteRaw(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse | null, McpOauthError, McpOauthServices> {
  return Effect.gen(function* () {
    // Metadata documents are served at the root well-known path and at the
    // /mcp path-inserted form (RFC 8414 / RFC 9728) — clients probe both.
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      yield* requireMethod(request, "GET");
      return yield* protectedResourceMetadata(request);
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      yield* requireMethod(request, "GET");
      return yield* authorizationServerMetadata(request);
    }
    if (url.pathname === "/oauth/register") {
      yield* requireMethod(request, "POST");
      return yield* register(request);
    }
    if (url.pathname === "/oauth/authorize") {
      yield* requireMethod(request, "GET");
      return yield* authorize(request, url);
    }
    if (url.pathname === "/oauth/consent") {
      yield* requireMethod(request, "POST");
      return yield* consent(request);
    }
    if (url.pathname === "/oauth/token") {
      yield* requireMethod(request, "POST");
      return yield* token(request);
    }
    return null;
  });
}

/** 405s any method other than the one a route serves (HEAD folds into GET). */
function requireMethod(request: HttpServerRequest.HttpServerRequest, method: string): Effect.Effect<void, HttpError> {
  const requestMethod = request.method === "HEAD" ? "GET" : request.method;
  return requestMethod === method
    ? Effect.void
    : Effect.fail(new HttpError({ status: 405, message: "Method not allowed" }));
}

// ---------------------------------------------------------------------------
// Discovery metadata
// ---------------------------------------------------------------------------

/** RFC 9728 protected-resource metadata: names this server's /mcp resource and
 * points at the authorization server (this same origin). */
function protectedResourceMetadata(request: HttpServerRequest.HttpServerRequest): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const base = appBaseUrl(request, config);
    return publicJson({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [MCP_SCOPE],
    });
  });
}

/** RFC 8414 authorization-server metadata. */
function authorizationServerMetadata(request: HttpServerRequest.HttpServerRequest): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const base = appBaseUrl(request, config);
    return publicJson({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_SCOPE],
    });
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

/** Handles `POST /oauth/register` (RFC 7591). */
function register(request: HttpServerRequest.HttpServerRequest): McpOauthEffect {
  return Effect.gen(function* () {
    const body = yield* readJsonBody(request);
    return yield* registerMcpClient(body).pipe(
      Effect.map((registration) => publicJson(registration, 201)),
      Effect.catchTag("McpClientRegistrationError", (error) =>
        Effect.succeed(publicJson({ error: error.error, error_description: error.description }, error.status)),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Authorize + consent
// ---------------------------------------------------------------------------

/** The validated parameters of one authorize request. */
interface AuthorizeRequest {
  readonly client: McpClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state?: string;
}

/** Handles `GET /oauth/authorize`: validates the request, then either sends an
 * anonymous browser through login and back, or renders the consent page. */
function authorize(request: HttpServerRequest.HttpServerRequest, url: URL): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const validated = yield* validateAuthorizeRequest(request, url);
    if ("response" in validated) return validated.response;

    const auth = yield* Auth;
    const user = yield* auth.currentUser(request);
    if (user == null) {
      const loginUrl = new URL("/auth/login", appBaseUrl(request, config));
      loginUrl.searchParams.set("returnTo", `${url.pathname}${url.search}`);
      return HttpServerResponse.redirect(loginUrl, { status: 302 });
    }

    const txn = yield* createMcpConsentToken(
      {
        clientId: validated.client.clientId,
        redirectUri: validated.redirectUri,
        codeChallenge: validated.codeChallenge,
        ...(validated.state == null ? {} : { state: validated.state }),
        userId: user.id,
      },
      config.auth,
    );
    return consentPageResponse(validated, user, txn, `${url.pathname}${url.search}`);
  });
}

/** Validates one authorize request in RFC 9700 order: nothing redirects until
 * the client and redirect URI are proven registered (an unproven redirect
 * target gets a 400 page, never a redirect); every later problem redirects
 * back to the now-trusted client with a spec error code. */
function validateAuthorizeRequest(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): Effect.Effect<
  AuthorizeRequest | { readonly response: HttpServerResponse.HttpServerResponse },
  McpOauthError,
  McpOauthServices
> {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const params = url.searchParams;
    const badRequest = (message: string) => new HttpError({ status: 400, message });

    const clientId = params.get("client_id");
    if (clientId == null || clientId === "") {
      return yield* Effect.fail(badRequest("Missing client_id"));
    }
    const client = yield* loadMcpClient(clientId);
    if (client == null) {
      return yield* Effect.fail(badRequest("Unknown client — the registration may have expired; retry connecting from your MCP client"));
    }
    const redirectUri = params.get("redirect_uri");
    if (redirectUri == null || !redirectUriMatches(client.redirectUris, redirectUri)) {
      return yield* Effect.fail(badRequest("redirect_uri is not registered for this client"));
    }
    // The state is echoed on every redirect below; an oversized one is
    // rejected with a page so it is never reflected anywhere.
    const state = params.get("state") ?? undefined;
    if (state != null && state.length > MAX_STATE_LENGTH) {
      return yield* Effect.fail(badRequest("state is too long"));
    }

    const redirectError = (error: string, description: string) => ({
      response: errorRedirect(redirectUri, error, description, state),
    });
    if (params.get("response_type") !== "code") {
      return redirectError("unsupported_response_type", 'Only response_type "code" is supported');
    }
    const codeChallenge = params.get("code_challenge");
    if (codeChallenge == null || !isPkceValue(codeChallenge)) {
      return redirectError("invalid_request", "A PKCE S256 code_challenge is required");
    }
    if (params.get("code_challenge_method") !== "S256") {
      return redirectError("invalid_request", 'code_challenge_method must be "S256"');
    }
    const scope = params.get("scope");
    if (scope != null && scope !== "" && scope !== MCP_SCOPE) {
      return redirectError("invalid_scope", `Only the "${MCP_SCOPE}" scope is supported`);
    }
    const resource = params.get("resource");
    if (resource != null && resource !== mcpResourceUrl(request, config)) {
      return redirectError("invalid_target", "This server's only resource is its /mcp endpoint");
    }

    return { client, redirectUri, codeChallenge, ...(state == null ? {} : { state }) };
  });
}

/** Handles `POST /oauth/consent`: the approval (or denial) form submission. */
function consent(request: HttpServerRequest.HttpServerRequest): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* rejectCrossOriginApiRequest(request, appBaseUrl(request, config));

    const form = yield* readFormBody(request);
    const txn = form.get("txn");
    const decision = form.get("decision");
    if (txn == null || (decision !== "approve" && decision !== "deny")) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Malformed consent submission" }));
    }
    const payload = yield* verifyMcpConsentToken(txn, config.auth);

    const auth = yield* Auth;
    const user = yield* auth.currentUser(request);
    if (user == null) {
      return yield* Effect.fail(new AuthError({ status: 401, message: "Your session expired — sign in and retry the authorization" }));
    }
    if (user.id !== payload.userId) {
      return yield* Effect.fail(new AuthError({ status: 403, message: "This authorization was started by a different account — retry it" }));
    }
    // Re-prove the registration: it may have expired (or been replaced) while
    // the consent page sat open, and the redirect must never outlive it.
    const client = yield* loadMcpClient(payload.clientId);
    if (client == null || !redirectUriMatches(client.redirectUris, payload.redirectUri)) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "This client registration is no longer valid — retry connecting from your MCP client" }));
    }

    if (decision === "deny") {
      return errorRedirect(payload.redirectUri, "access_denied", "The user denied the authorization", payload.state);
    }
    const code = yield* issueMcpAuthorizationCode(user, {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
    }, config.auth);
    const target = new URL(payload.redirectUri);
    target.searchParams.set("code", code);
    if (payload.state != null) target.searchParams.set("state", payload.state);
    return HttpServerResponse.redirect(target.toString(), { status: 302 });
  });
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/** Handles `POST /oauth/token`: the authorization_code and refresh_token
 * grants, with RFC 6749 §5.2 error bodies. */
function token(request: HttpServerRequest.HttpServerRequest): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const form = yield* readFormBody(request);
    const aud = mcpResourceUrl(request, config);

    const grantType = form.get("grant_type");
    const grant = grantType === "authorization_code"
      ? codeGrant(form, aud)
      : grantType === "refresh_token"
        ? refreshGrant(form, aud)
        : Effect.succeed(oauthTokenError(400, "unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"'));
    return yield* grant;
  });
}

/** The authorization_code grant: burn, prove possession, mint access + refresh. */
function codeGrant(form: URLSearchParams, aud: string): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const clientId = form.get("client_id");
    if (code == null || codeVerifier == null || redirectUri == null || clientId == null) {
      return oauthTokenError(400, "invalid_request", "code, code_verifier, redirect_uri, and client_id are required");
    }
    const resource = form.get("resource");
    if (resource != null && resource !== aud) {
      return oauthTokenError(400, "invalid_target", "This server's only resource is its /mcp endpoint");
    }

    const payload = yield* decodeMcpAuthorizationCode(code, config.auth).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (payload == null) {
      return oauthTokenError(400, "invalid_grant", "Invalid or expired authorization code");
    }
    // The registration must still be live: a code cannot outlive its client.
    const client = yield* loadMcpClient(payload.clientId);
    if (client == null) {
      return oauthTokenError(401, "invalid_client", "Unknown client — the registration may have expired");
    }
    const burned = yield* burnOneTimeCode(MCP_CODE_NAMESPACE, payload.id, payload.expiresAt).pipe(
      Effect.as(true),
      Effect.catchTag("AuthError", () => Effect.succeed(false)),
    );
    if (!burned) {
      return oauthTokenError(400, "invalid_grant", "Authorization code already redeemed");
    }
    const user = yield* verifyMcpCodeExchange(payload, { codeVerifier, redirectUri, clientId }, config.auth).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (user == null) {
      return oauthTokenError(400, "invalid_grant", "Authorization code does not match this request");
    }

    const principal = { user, clientId: payload.clientId };
    const accessToken = yield* createMcpAccessToken(principal, aud, config.auth);
    const refreshToken = yield* createMcpRefreshToken(principal, aud, config.auth);
    return publicJson({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: MCP_SCOPE,
    });
  });
}

/** The refresh_token grant: mint a fresh access token. The refresh token is
 * not rotated — stateless rotation cannot revoke the predecessor, so rotation
 * would only pretend to; the levers are the allow-list and MCP_TOKEN_VERSION. */
function refreshGrant(form: URLSearchParams, aud: string): McpOauthEffect {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (refreshToken == null || clientId == null) {
      return oauthTokenError(400, "invalid_request", "refresh_token and client_id are required");
    }
    const principal = yield* verifyMcpRefreshToken(refreshToken, aud, config.auth).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (principal == null || principal.clientId !== clientId) {
      return oauthTokenError(400, "invalid_grant", "Invalid or expired refresh token");
    }
    const client = yield* loadMcpClient(clientId);
    if (client == null) {
      return oauthTokenError(401, "invalid_client", "Unknown client — the registration may have expired");
    }
    const accessToken = yield* createMcpAccessToken(principal, aud, config.auth);
    return publicJson({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TTL_SECONDS,
      scope: MCP_SCOPE,
    });
  });
}

// ---------------------------------------------------------------------------
// Consent page
// ---------------------------------------------------------------------------

/** Renders the consent page. Framing is refused so approval clicks cannot be
 * hijacked, and the page carries the standard no-store security headers. */
function consentPageResponse(
  authorizeRequest: AuthorizeRequest,
  user: AuthUser,
  txn: string,
  retryPath: string,
): HttpServerResponse.HttpServerResponse {
  const clientName = authorizeRequest.client.clientName ?? authorizeRequest.client.clientId;
  const redirectHost = new URL(authorizeRequest.redirectUri).host || "your MCP client";
  return HttpServerResponse.text(
    consentPageHtml({ clientName, redirectHost, email: user.email, txn, retryPath }),
    {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        ...securityHeaders(),
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

/** The consent page document, in the error pages' visual style. */
function consentPageHtml(page: {
  readonly clientName: string;
  readonly redirectHost: string;
  readonly email: string;
  readonly txn: string;
  readonly retryPath: string;
}): string {
  const switchHref = `/auth/login?returnTo=${encodeURIComponent(page.retryPath)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Authorize ${escapeHtml(page.clientName)} · scratchwork</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FIGURE_SVG)}" />
    <style>
      :root {
        --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
        --gray-100: #f3f4f6;
        --gray-200: #e5e7eb;
        --gray-400: #9ca3af;
        --gray-500: #6b7280;
        --gray-700: #374151;
        --gray-900: #111827;
      }
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #fff;
        color: var(--gray-700);
        font-family: var(--font-sans);
        font-size: 1rem;
        line-height: 1.6;
      }
      main { max-width: 26rem; padding: 3rem 1.5rem; text-align: center; }
      .figure { width: 6.5rem; margin: 0 auto 1.5rem; }
      .figure svg { display: block; width: 100%; height: auto; }
      h1 {
        margin: 0 0 0.5em;
        font-size: 1.4em;
        font-weight: 700;
        line-height: 1.3;
        color: var(--gray-900);
        text-wrap: balance;
      }
      p { margin: 0.5em 0; }
      .note { color: var(--gray-500); font-size: 0.875em; }
      .note a { color: inherit; }
      form { margin: 0; }
      .actions {
        margin-top: 1.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: center;
      }
      .button {
        display: inline-block;
        border: 0;
        cursor: pointer;
        border-radius: 0.5rem;
        padding: 0.5rem 1rem;
        font-family: inherit;
        font-size: 0.9375rem;
        font-weight: 500;
        transition: background 150ms ease, color 150ms ease;
      }
      .button.primary { background: var(--gray-900); color: #fff; }
      .button.primary:hover { background: var(--gray-700); }
      .button.secondary { background: var(--gray-100); color: var(--gray-700); }
      .button.secondary:hover { background: var(--gray-200); }
      .button:focus-visible { outline: 2px solid var(--gray-400); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <div class="figure">${FIGURE_SVG.trim()}</div>
      <h1>Authorize ${escapeHtml(page.clientName)}?</h1>
      <p>${escapeHtml(page.clientName)} wants to publish and manage Scratchwork projects as <strong>${escapeHtml(page.email)}</strong>.</p>
      <p class="note">You&#39;ll be sent back to ${escapeHtml(page.redirectHost)}. Not you? <a href="${escapeHtml(switchHref)}">Use a different account</a>.</p>
      <form method="post" action="/oauth/consent" class="actions">
        <input type="hidden" name="txn" value="${escapeHtml(page.txn)}" />
        <button class="button primary" type="submit" name="decision" value="approve">Authorize</button>
        <button class="button secondary" type="submit" name="decision" value="deny">Deny</button>
      </form>
    </main>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Request/response plumbing
// ---------------------------------------------------------------------------

/** Reads and parses a small JSON request body. */
function readJsonBody(request: HttpServerRequest.HttpServerRequest): Effect.Effect<unknown, HttpError> {
  return Effect.gen(function* () {
    const text = yield* readCappedBody(request);
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new HttpError({ status: 400, message: "Invalid JSON body" }),
    });
  });
}

/** Reads and parses a small application/x-www-form-urlencoded request body. */
function readFormBody(request: HttpServerRequest.HttpServerRequest): Effect.Effect<URLSearchParams, HttpError> {
  return Effect.map(readCappedBody(request), (text) => new URLSearchParams(text));
}

/** Reads a request body under the shared OAuth-endpoint size cap. */
function readCappedBody(request: HttpServerRequest.HttpServerRequest): Effect.Effect<string, HttpError> {
  return Effect.gen(function* () {
    const text = yield* request.text.pipe(
      HttpServerRequest.withMaxBodySize(Option.some(MAX_OAUTH_BODY_BYTES)),
      Effect.mapError((cause) => new HttpError({ status: 413, message: "Request body is too large", cause })),
    );
    if (new TextEncoder().encode(text).byteLength > MAX_OAUTH_BODY_BYTES) {
      return yield* Effect.fail(new HttpError({ status: 413, message: "Request body is too large" }));
    }
    return text;
  });
}

/** A JSON response readable by any origin: only for the four endpoints that
 * never read an ambient credential (metadata, register, token). */
function publicJson(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.unsafeJson(body, {
    status,
    headers: { ...securityHeaders(), "Access-Control-Allow-Origin": "*" },
  });
}

/** An RFC 6749 §5.2 token-endpoint error body. */
function oauthTokenError(status: number, error: string, description: string): HttpServerResponse.HttpServerResponse {
  return publicJson({ error, error_description: description }, status);
}

/** Redirects an authorize-time failure back to the (already validated)
 * redirect URI with the spec error parameters. */
function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
): HttpServerResponse.HttpServerResponse {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state != null) target.searchParams.set("state", state);
  return HttpServerResponse.redirect(target.toString(), { status: 302 });
}
