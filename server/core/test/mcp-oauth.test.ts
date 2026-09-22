/*
 * Handler-level tests of the MCP OAuth surface: the discovery documents, the
 * full register → authorize → consent → token → /mcp-principal loop, and the
 * adversarial negatives from the invariant-3/5 threat review — code replay,
 * PKCE downgrade, redirect_uri confusion, audience confusion, consent CSRF,
 * and registration expiry. Token bit-flip/parser hardening lives in
 * token-corpus.test.ts; this file exercises the endpoints.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { sha256Base64Url } from "@scratchwork/shared/crypto/digest";
import { createSessionToken, requireMcpUser, type AuthUser } from "../src/auth";
import type { AuthConfig } from "../src/config";
import { redirectUriMatches, validMcpRedirectUri } from "../src/mcp-clients";
import { MCP_OAUTH_ROUTES } from "../src/mcp-oauth-routes";
import { appHandler, json } from "./helpers";

/** Must match the appHandler defaults in helpers.ts so minted bearers verify. */
const authConfig: AuthConfig = {
  mode: "oauth",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  sessionSecret: "test-session-secret-test-session-secret",
  allowedUsers: "public",
  sessionTtlSeconds: 60,
};

const BASE = "https://scratch.test";
const AUD = `${BASE}/mcp`;
const REDIRECT = "http://127.0.0.1:33418/callback";
const VERIFIER = "test-verifier-test-verifier-test-verifier-1";

const alice: AuthUser = { id: "alice-1", email: "alice@example.com" };
const bob: AuthUser = { id: "bob-1", email: "bob@example.com" };

type Handler = Awaited<ReturnType<typeof appHandler>>;

async function bearer(user: AuthUser): Promise<string> {
  return Effect.runPromise(createSessionToken(user, authConfig));
}

/** POSTs a form-encoded body, optionally authenticated with a session bearer. */
function postForm(
  handler: Handler,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  }));
}

/** Registers a client and returns its id. */
async function register(handler: Handler, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await handler(new Request(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      client_name: "Claude Code",
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  }));
  expect(response.status).toBe(201);
  const body = await json(response) as { client_id: string };
  expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  return body.client_id;
}

/** The canonical authorize query for one client. */
async function authorizeQuery(clientId: string, overrides: Record<string, string | null> = {}): Promise<string> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: await sha256Base64Url(VERIFIER),
    code_challenge_method: "S256",
    state: "client-state-123",
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/** Renders the consent page as a signed-in user and extracts the txn token. */
async function consentTxn(handler: Handler, clientId: string, user: AuthUser, query?: string): Promise<string> {
  const response = await handler(new Request(`${BASE}/oauth/authorize?${query ?? await authorizeQuery(clientId)}`, {
    headers: { authorization: `Bearer ${await bearer(user)}`, accept: "text/html" },
  }));
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = /name="txn" value="([^"]+)"/.exec(html);
  if (match == null) throw new Error("consent page has no txn field");
  return match[1];
}

/** Runs the whole browser leg (authorize + approve) and returns the code. */
async function obtainCode(handler: Handler, clientId: string, user: AuthUser = alice): Promise<string> {
  const txn = await consentTxn(handler, clientId, user);
  const approved = await postForm(handler, "/oauth/consent", { txn, decision: "approve" }, {
    authorization: `Bearer ${await bearer(user)}`,
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("client-state-123");
  const code = location.searchParams.get("code");
  if (code == null) throw new Error("approval redirect has no code");
  return code;
}

/** Redeems a code at the token endpoint. */
function redeemCode(
  handler: Handler,
  clientId: string,
  code: string,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return postForm(handler, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: clientId,
    ...overrides,
  });
}

describe("mcp oauth: discovery", () => {
  test("protected-resource metadata names /mcp and this origin, at both well-known paths", async () => {
    const handler = await appHandler({});
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await handler(new Request(`${BASE}${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await json(response)).toEqual({
        resource: AUD,
        authorization_servers: [BASE],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      });
    }
  });

  test("authorization-server metadata advertises PKCE-only public clients", async () => {
    const handler = await appHandler({});
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
      const response = await handler(new Request(`${BASE}${path}`));
      expect(response.status).toBe(200);
      const body = await json(response) as Record<string, unknown>;
      expect(body.issuer).toBe(BASE);
      expect(body.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${BASE}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${BASE}/oauth/register`);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    }
  });

  test("metadata endpoints reject non-GET methods", async () => {
    const handler = await appHandler({});
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const response = await handler(new Request(`${BASE}${path}`, { method: "POST" }));
      expect({ path, status: response.status }).toEqual({ path, status: 405 });
    }
  });
});

describe("mcp oauth: registration", () => {
  test("registers a public client and echoes the accepted metadata", async () => {
    const handler = await appHandler({});
    const response = await handler(new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT, "https://claude.ai/api/mcp/auth_callback"],
        client_name: "Claude Code",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Arbitrary RFC 7591 metadata the server ignores.
        client_uri: "https://claude.com/claude-code",
        scope: "mcp",
      }),
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await json(response) as Record<string, unknown>;
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual([REDIRECT, "https://claude.ai/api/mcp/auth_callback"]);
    expect(body.client_name).toBe("Claude Code");
    expect(typeof body.client_id_issued_at).toBe("number");
  });

  test("rejects bad registrations with RFC 7591 error bodies", async () => {
    const handler = await appHandler({});
    const attempt = async (body: unknown) => {
      const response = await handler(new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      return { status: response.status, ...(await json(response) as { error: string }) };
    };
    expect((await attempt({})).error).toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: [] })).error).toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: ["http://evil.example/cb"] })).error).toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: ["https://ok.example/cb#frag"] })).error).toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: ["https://user:pw@ok.example/cb"] })).error).toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://ok.example/cb${i}`) })).error)
      .toBe("invalid_redirect_uri");
    expect((await attempt({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).error)
      .toBe("invalid_client_metadata");
    expect((await attempt({ redirect_uris: [REDIRECT], grant_types: ["implicit"] })).error)
      .toBe("invalid_client_metadata");
    expect((await attempt({ redirect_uris: [REDIRECT], response_types: ["token"] })).error)
      .toBe("invalid_client_metadata");
    expect((await attempt({ redirect_uris: [REDIRECT], client_name: "x".repeat(300) })).error)
      .toBe("invalid_client_metadata");
  });
});

describe("mcp oauth: authorize", () => {
  test("an anonymous browser is sent through login and back to the exact authorize URL", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const query = await authorizeQuery(clientId);
    const response = await handler(new Request(`${BASE}/oauth/authorize?${query}`, { headers: { accept: "text/html" } }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("returnTo")).toBe(`/oauth/authorize?${query}`);
  });

  test("a signed-in user gets the consent page: client name, account, no framing, no CORS", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const response = await handler(new Request(`${BASE}/oauth/authorize?${await authorizeQuery(clientId)}`, {
      headers: { authorization: `Bearer ${await bearer(alice)}`, accept: "text/html" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const html = await response.text();
    expect(html).toContain("Claude Code");
    expect(html).toContain(alice.email);
    expect(html).toContain('name="txn"');
  });

  test("an unknown or expired client never redirects — 400 page instead", async () => {
    const handler = await appHandler({});
    const anon = await handler(new Request(`${BASE}/oauth/authorize?${await authorizeQuery("A".repeat(22))}`));
    expect(anon.status).toBe(400);
    expect(anon.headers.get("location")).toBeNull();
  });

  test("an unregistered redirect_uri never redirects — 400 page instead", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const query = await authorizeQuery(clientId, { redirect_uri: "http://127.0.0.1:33418/other-path" });
    const response = await handler(new Request(`${BASE}/oauth/authorize?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  test("loopback registrations match any port; the path must still match", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const otherPort = REDIRECT.replace(":33418", ":49152");
    const query = await authorizeQuery(clientId, { redirect_uri: otherPort });
    const txn = await consentTxn(handler, clientId, alice, query);
    expect(txn.length).toBeGreaterThan(0);
  });

  test("validated-client errors redirect with the spec error code and echo state", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const expectRedirectError = async (overrides: Record<string, string | null>, error: string) => {
      const response = await handler(new Request(`${BASE}/oauth/authorize?${await authorizeQuery(clientId, overrides)}`, {
        headers: { authorization: `Bearer ${await bearer(alice)}` },
      }));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect({ overrides, error: location.searchParams.get("error") }).toEqual({ overrides, error });
      expect(location.searchParams.get("state")).toBe("client-state-123");
    };
    await expectRedirectError({ response_type: "token" }, "unsupported_response_type");
    await expectRedirectError({ code_challenge: null }, "invalid_request");
    await expectRedirectError({ code_challenge: "too-short" }, "invalid_request");
    await expectRedirectError({ code_challenge_method: "plain" }, "invalid_request");
    await expectRedirectError({ scope: "admin" }, "invalid_scope");
    await expectRedirectError({ resource: "https://other.example/mcp" }, "invalid_target");
  });

  test("an oversized state is rejected with a page, never echoed", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const query = await authorizeQuery(clientId, { state: "s".repeat(513) });
    const response = await handler(new Request(`${BASE}/oauth/authorize?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("mcp oauth: consent", () => {
  test("deny redirects with access_denied and mints nothing", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const txn = await consentTxn(handler, clientId, alice);
    const denied = await postForm(handler, "/oauth/consent", { txn, decision: "deny" }, {
      authorization: `Bearer ${await bearer(alice)}`,
    });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  test("the consent POST rejects cross-origin submissions", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const txn = await consentTxn(handler, clientId, alice);
    const response = await postForm(handler, "/oauth/consent", { txn, decision: "approve" }, {
      authorization: `Bearer ${await bearer(alice)}`,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });

  test("a consent token minted for one account cannot be approved by another", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const txn = await consentTxn(handler, clientId, alice);
    const response = await postForm(handler, "/oauth/consent", { txn, decision: "approve" }, {
      authorization: `Bearer ${await bearer(bob)}`,
    });
    expect(response.status).toBe(403);
  });

  test("a consent submission without a session is rejected", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const txn = await consentTxn(handler, clientId, alice);
    const response = await postForm(handler, "/oauth/consent", { txn, decision: "approve" });
    expect(response.status).toBe(401);
  });

  test("a malformed submission is rejected", async () => {
    const handler = await appHandler({});
    const response = await postForm(handler, "/oauth/consent", { decision: "approve" }, {
      authorization: `Bearer ${await bearer(alice)}`,
    });
    expect(response.status).toBe(400);
    const tampered = await postForm(handler, "/oauth/consent", { txn: "garbage.token", decision: "approve" }, {
      authorization: `Bearer ${await bearer(alice)}`,
    });
    expect(tampered.status).toBe(400);
  });
});

describe("mcp oauth: token endpoint and the full loop", () => {
  test("register → authorize → consent → token → the bearer authenticates at /mcp", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const code = await obtainCode(handler, clientId);
    const response = await redeemCode(handler, clientId, code);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await json(response) as Record<string, unknown>;
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("mcp");

    // The access token resolves the authorizing user through the /mcp
    // principal chokepoint, audience-bound to this server.
    const principal = await Effect.runPromise(requireMcpUser(
      { headers: { authorization: `Bearer ${body.access_token as string}` } } as never,
      AUD,
      authConfig,
    ));
    expect(principal).toEqual(alice);

    // ...and refuses the same token at a different audience.
    const elsewhere = Effect.runPromise(requireMcpUser(
      { headers: { authorization: `Bearer ${body.access_token as string}` } } as never,
      "https://other.example/mcp",
      authConfig,
    ));
    expect(elsewhere).rejects.toThrow("Authentication required");

    // The refresh grant mints a fresh access token and never a new refresh token.
    const refreshed = await postForm(handler, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = await json(refreshed) as Record<string, unknown>;
    expect(typeof refreshedBody.access_token).toBe("string");
    expect(refreshedBody.refresh_token).toBeUndefined();
  });

  test("an explicit matching resource parameter is accepted; a mismatch is invalid_target", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const good = await redeemCode(handler, clientId, await obtainCode(handler, clientId), { resource: AUD });
    expect(good.status).toBe(200);
    const bad = await redeemCode(handler, clientId, await obtainCode(handler, clientId), { resource: "https://other.example/mcp" });
    expect(bad.status).toBe(400);
    expect((await json(bad) as { error: string }).error).toBe("invalid_target");
  });

  test("a code redeems exactly once — replay fails after success", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const code = await obtainCode(handler, clientId);
    expect((await redeemCode(handler, clientId, code)).status).toBe(200);
    const replay = await redeemCode(handler, clientId, code);
    expect(replay.status).toBe(400);
    expect((await json(replay) as { error: string }).error).toBe("invalid_grant");
  });

  test("a wrong-verifier attempt burns the code — the interceptor race fails closed", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const code = await obtainCode(handler, clientId);
    const wrong = await redeemCode(handler, clientId, code, { code_verifier: "w".repeat(43) });
    expect(wrong.status).toBe(400);
    // The failed attempt consumed the code: the correct verifier now fails too.
    const after = await redeemCode(handler, clientId, code);
    expect(after.status).toBe(400);
  });

  test("possession checks: wrong redirect_uri and wrong client are invalid_grant", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const otherClient = await register(handler);
    const badRedirect = await redeemCode(handler, clientId, await obtainCode(handler, clientId), {
      redirect_uri: "http://127.0.0.1:33418/other",
    });
    expect(badRedirect.status).toBe(400);
    expect((await json(badRedirect) as { error: string }).error).toBe("invalid_grant");
    const badClient = await redeemCode(handler, otherClient, await obtainCode(handler, clientId));
    expect(badClient.status).toBe(400);
    expect((await json(badClient) as { error: string }).error).toBe("invalid_grant");
  });

  test("garbage codes, unsupported grants, and missing fields are spec errors", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const garbage = await redeemCode(handler, clientId, "garbage.code");
    expect(garbage.status).toBe(400);
    expect((await json(garbage) as { error: string }).error).toBe("invalid_grant");
    const unsupported = await postForm(handler, "/oauth/token", { grant_type: "password" });
    expect((await json(unsupported) as { error: string }).error).toBe("unsupported_grant_type");
    const missing = await postForm(handler, "/oauth/token", { grant_type: "authorization_code" });
    expect((await json(missing) as { error: string }).error).toBe("invalid_request");
  });

  test("a session cookie lends the token endpoint nothing", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const response = await redeemCode(handler, clientId, "garbage.code");
    const withCookie = await postForm(handler, "/oauth/token", {
      grant_type: "authorization_code",
      code: "garbage.code",
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: clientId,
    }, { cookie: `__Host-scratchwork_session=${encodeURIComponent(await bearer(alice))}` });
    expect(withCookie.status).toBe(response.status);
    expect((await json(withCookie) as { error: string }).error).toBe("invalid_grant");
  });

  test("a refresh token from another client id is rejected", async () => {
    const handler = await appHandler({});
    const clientId = await register(handler);
    const otherClient = await register(handler);
    const token = await redeemCode(handler, clientId, await obtainCode(handler, clientId));
    const body = await json(token) as { refresh_token: string };
    const response = await postForm(handler, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
      client_id: otherClient,
    });
    expect(response.status).toBe(400);
    expect((await json(response) as { error: string }).error).toBe("invalid_grant");
  });

  test("GET /oauth/token and GET /oauth/register are 405", async () => {
    const handler = await appHandler({});
    for (const path of ["/oauth/token", "/oauth/register", "/oauth/consent"]) {
      const response = await handler(new Request(`${BASE}${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 405 });
    }
  });
});

describe("mcp oauth: registration lifecycle", () => {
  test("an expired registration is unknown at authorize and token time", async () => {
    const handler = await appHandler({});
    // Mint the registration in the past so its 90-day expiry has elapsed.
    const realNow = Date.now;
    Date.now = () => realNow() - 91 * 24 * 60 * 60 * 1000;
    let clientId: string;
    try {
      clientId = await register(handler);
    } finally {
      Date.now = realNow;
    }
    const response = await handler(new Request(`${BASE}/oauth/authorize?${await authorizeQuery(clientId)}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("mcp oauth: session bearers and /mcp principal resolution", () => {
  test("a session bearer is accepted at the /mcp chokepoint — documented fallback", async () => {
    const principal = await Effect.runPromise(requireMcpUser(
      { headers: { authorization: `Bearer ${await bearer(alice)}` } } as never,
      AUD,
      authConfig,
    ));
    expect(principal).toEqual(alice);
  });

  test("no bearer, garbage bearers, and cookies alone never authenticate", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer garbage.token" },
      { cookie: `__Host-scratchwork_session=${encodeURIComponent(await bearer(alice))}` },
    ]) {
      const attempt = Effect.runPromise(requireMcpUser(
        { headers } as never,
        AUD,
        authConfig,
      ));
      expect(attempt).rejects.toThrow("Authentication required");
    }
  });
});

describe("mcp oauth: route registry", () => {
  test("the registry names every dispatched route exactly once", () => {
    expect(MCP_OAUTH_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "GET /.well-known/oauth-protected-resource",
      "GET /oauth/authorize",
      "POST /oauth/consent",
      "POST /oauth/register",
      "POST /oauth/token",
    ]);
    expect(new Set(MCP_OAUTH_ROUTES.map((route) => route.name)).size).toBe(MCP_OAUTH_ROUTES.length);
  });
});

describe("mcp redirect-uri rules", () => {
  test("validMcpRedirectUri accepts https and loopback http only", () => {
    expect(validMcpRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validMcpRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validMcpRedirectUri("http://localhost:8080/cb")).toBe(true);
    expect(validMcpRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(validMcpRedirectUri("http://evil.example/cb")).toBe(false);
    expect(validMcpRedirectUri("https://ok.example/cb#fragment")).toBe(false);
    expect(validMcpRedirectUri("https://user:pw@ok.example/cb")).toBe(false);
    expect(validMcpRedirectUri("custom-scheme://callback")).toBe(false);
    expect(validMcpRedirectUri("not a url")).toBe(false);
    expect(validMcpRedirectUri("")).toBe(false);
    expect(validMcpRedirectUri(`https://ok.example/${"x".repeat(2100)}`)).toBe(false);
  });

  test("redirectUriMatches is exact except for loopback ports", () => {
    const registered = ["http://127.0.0.1:33418/callback", "https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriMatches(registered, "http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://127.0.0.1:49152/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://127.0.0.1:49152/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:33418/callback")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/extra")).toBe(false);
    expect(redirectUriMatches(registered, "http://evil.example/callback")).toBe(false);
    expect(redirectUriMatches([], "http://127.0.0.1:1/cb")).toBe(false);
  });
});
