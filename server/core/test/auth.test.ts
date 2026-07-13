import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { bytesToBase64Url } from "../../../shared/src/encoding/base64";
import {
  createSessionToken,
  decodeCliAuthorizationCode,
  makeAuth,
  verifyCliCodeExchange,
  type AuthUser,
} from "../src/auth";
import { readServerConfig, type AuthConfig, type CloudflareAccessAuthConfig } from "../src/config";
import { jwksFetch, makeKeyPair, nowSeconds, signJwt, type TestKeyPair } from "./jwt-helpers";

const user: AuthUser = {
  id: "google-user-1",
  email: "founder@example.com",
  name: "Founder",
};

const googleConfig: AuthConfig = {
  mode: "oauth",
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  sessionSecret: "session-secret-session-secret-32-bytes",
  allowedUsers: "public",
  sessionTtlSeconds: 60,
};

/** A fixed CLI PKCE verifier (43 base64url characters, the RFC 7636 minimum). */
const CLI_VERIFIER = "test-code-verifier-test-code-verifier-test1";

/** Computes the S256 challenge for a PKCE verifier. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** Builds the /auth/login URL a CLI sends: loopback redirect, state echo, and challenge. */
async function cliLoginUrl(baseUrl: string, options: { readonly cliState?: string; readonly verifier?: string } = {}): Promise<URL> {
  const url = new URL(`${baseUrl}/auth/login`);
  url.searchParams.set("cli_redirect", "http://127.0.0.1:5555/callback");
  url.searchParams.set("cli_state", options.cliState ?? "cli-state-1");
  url.searchParams.set("cli_code_challenge", await s256(options.verifier ?? CLI_VERIFIER));
  return url;
}

/** Extracts the decoded cookie value from a Set-Cookie header. */
function cookieValueFromSetCookie(setCookie: string): string {
  const pair = setCookie.split(";")[0] ?? "";
  return decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
}

describe("Auth", () => {
  test("accepts a signed bearer session token", async () => {
    const token = await Effect.runPromise(createSessionToken(user, googleConfig));
    const auth = makeAuth(googleConfig);

    const currentUser = await Effect.runPromise(
      auth.currentUser(request({ authorization: `Bearer ${token}` })),
    );

    expect(currentUser?.email).toBe("founder@example.com");
  });

  test("rejects a signed token outside allowed domains", async () => {
    const config = { ...googleConfig, allowedUsers: "@yc.com" };
    const token = await Effect.runPromise(createSessionToken(user, config));
    const auth = makeAuth(config);

    const currentUser = await Effect.runPromise(
      auth.currentUser(request({ authorization: `Bearer ${token}` })),
    );

    expect(currentUser).toBeNull();
  });

  test("does not accept cookie sessions for API publish auth", async () => {
    const token = await Effect.runPromise(createSessionToken(user, googleConfig));
    const auth = makeAuth(googleConfig);

    await expect(
      Effect.runPromise(auth.requireApiUser(request({ cookie: `scratchwork_session=${encodeURIComponent(token)}` }))),
    ).rejects.toThrow("Authentication required");
  });

  test("binds project-access tokens to one project, scope, and use", async () => {
    const auth = makeAuth(googleConfig);
    const token = await Effect.runPromise(auth.issueProjectAccessToken("site", user, "cookie"));

    // The payload carries the project, the path scope, and the access-token version.
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(token.split(".")[0])));
    expect(payload.version).toBe(1);
    expect(payload.project).toBe("site");
    expect(payload.scope).toBe("/site");

    expect((await Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "cookie")))?.email).toBe(user.email);
    // A token for one project does not verify for another, nor across uses.
    expect(await Effect.runPromise(auth.verifyProjectAccessToken(token, "other", "cookie"))).toBeNull();
    expect(await Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "handoff"))).toBeNull();
  });

  test("OAuth login redirects to Google with PKCE and an opaque state, and never relays a cf_token", async () => {
    const auth = makeAuth(googleConfig);
    const response = await Effect.runPromise(auth.login(
      request({}),
      await cliLoginUrl("https://app.scratch.test"),
      "https://app.scratch.test",
    ));

    const web = HttpServerResponse.toWeb(response);
    const location = new URL(web.headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("cf_token")).toBeNull();
    // The provider leg carries PKCE; the state parameter is an opaque random value,
    // not the signed state token — the token (holding the verifier) stays in the
    // browser cookie and never transits the provider.
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    const stateCookie = web.headers.get("set-cookie") ?? "";
    expect(stateCookie).toContain("__Host-scratchwork_oauth_state=");
    expect(stateCookie).not.toContain(location.searchParams.get("state") ?? "unset");
  });

  test("OAuth login with a CLI redirect requires the CLI state and PKCE challenge", async () => {
    const auth = makeAuth(googleConfig);
    const url = new URL("https://app.scratch.test/auth/login?cli_redirect=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback");
    await expect(
      Effect.runPromise(auth.login(request({}), url, "https://app.scratch.test")),
    ).rejects.toThrow("cli_code_challenge");
  });

  test("OAuth callback hands the CLI loopback a one-time code, never the bearer token", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const auth = makeAuth(googleConfig);
      const baseUrl = "https://app.scratch.test";
      const loginResponse = HttpServerResponse.toWeb(await Effect.runPromise(auth.login(
        request({}),
        await cliLoginUrl(baseUrl),
        baseUrl,
      )));
      const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://invalid");
      const state = authorizeUrl.searchParams.get("state") ?? "";
      const nonce = authorizeUrl.searchParams.get("nonce") ?? "";
      const providerChallenge = authorizeUrl.searchParams.get("code_challenge") ?? "";
      const stateCookie = cookieValueFromSetCookie(loginResponse.headers.get("set-cookie") ?? "");

      // Google's side of the exchange: the token endpoint returns an ID token signed by
      // a test key served from Google's JWKS URL, and must be sent the PKCE verifier
      // whose S256 digest was in the authorization request.
      const keyPair = await makeKeyPair();
      const idToken = await signJwt(keyPair.privateKey, {
        iss: "https://accounts.google.com",
        aud: googleConfig.mode === "oauth" ? googleConfig.clientId : "",
        sub: "google-user-1",
        email: "founder@example.com",
        email_verified: true,
        exp: nowSeconds() + 600,
        nonce,
      });
      let exchangedVerifier: string | null = null;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          exchangedVerifier = new URLSearchParams(String(init?.body)).get("code_verifier");
          return Response.json({ id_token: idToken });
        }
        return jwksFetch(keyPair.publicJwk)(input);
      }) as typeof fetch;

      const response = await Effect.runPromise(auth.callback(
        request({ cookie: `__Host-scratchwork_oauth_state=${encodeURIComponent(stateCookie)}` }),
        new URL(`${baseUrl}/auth/callback/google?code=auth-code&state=${encodeURIComponent(state)}`),
        baseUrl,
      ));

      expect(exchangedVerifier).not.toBeNull();
      expect(await s256(exchangedVerifier ?? "")).toBe(providerChallenge);

      const location = new URL(HttpServerResponse.toWeb(response).headers.get("location") ?? "https://invalid");
      expect(location.origin).toBe("http://127.0.0.1:5555");
      expect(location.searchParams.get("state")).toBe("cli-state-1");
      expect(location.searchParams.get("code")).not.toBeNull();
      // The loopback query string carries only the code: no bearer token, no email,
      // no relayed Access JWT.
      expect(location.searchParams.get("token")).toBeNull();
      expect(location.searchParams.get("email")).toBeNull();
      expect(location.searchParams.get("cf_token")).toBeNull();

      // The code redeems only with the matching PKCE verifier and exact redirect URI.
      const payload = await Effect.runPromise(decodeCliAuthorizationCode(location.searchParams.get("code") ?? "", googleConfig));
      expect(payload.provider).toBe("google");
      const redeemed = await Effect.runPromise(
        verifyCliCodeExchange(payload, CLI_VERIFIER, "http://127.0.0.1:5555/callback", googleConfig),
      );
      expect(redeemed.email).toBe("founder@example.com");
      await expect(
        Effect.runPromise(verifyCliCodeExchange(payload, `${CLI_VERIFIER}-wrong`, "http://127.0.0.1:5555/callback", googleConfig)),
      ).rejects.toThrow("does not match");
      await expect(
        Effect.runPromise(verifyCliCodeExchange(payload, CLI_VERIFIER, "http://127.0.0.1:6666/callback", googleConfig)),
      ).rejects.toThrow("does not match");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("OAuth callback relays a provider denial to the CLI loopback", async () => {
    const auth = makeAuth(googleConfig);
    const baseUrl = "https://app.scratch.test";
    const loginResponse = HttpServerResponse.toWeb(await Effect.runPromise(auth.login(
      request({}),
      await cliLoginUrl(baseUrl),
      baseUrl,
    )));
    const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://invalid");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    const stateCookie = cookieValueFromSetCookie(loginResponse.headers.get("set-cookie") ?? "");

    const response = await Effect.runPromise(auth.callback(
      request({ cookie: `__Host-scratchwork_oauth_state=${encodeURIComponent(stateCookie)}` }),
      new URL(`${baseUrl}/auth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`),
      baseUrl,
    ));

    const location = new URL(HttpServerResponse.toWeb(response).headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("http://127.0.0.1:5555");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("cli-state-1");
    expect(location.searchParams.get("code")).toBeNull();
  });

  test("rejects old-format project-access tokens as invalid, not as a crash", async () => {
    const auth = makeAuth(googleConfig);
    // A token in the retired workspace-era shape (projectKey/routePath) signed with the
    // real secret must fail schema decode and read as an invalid token.
    const legacy = await signLegacyToken(
      {
        version: 1,
        kind: "project-access",
        use: "cookie",
        projectKey: "demo/site",
        routePath: "demo/site",
        email: user.email,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      googleConfig.sessionSecret,
    );

    await expect(
      Effect.runPromise(auth.verifyProjectAccessToken(legacy, "site", "cookie")),
    ).rejects.toThrow("Invalid auth token");
  });
});

// Each key pair gets its own team domain because the production JWKS cache is
// process-global and keyed by JWKS URL, which the auth service derives from the team.
const cfTeamDomain = "https://auth-test.cloudflareaccess.com";

const cloudflareConfig: CloudflareAccessAuthConfig = {
  mode: "cloudflare-access",
  teamDomain: cfTeamDomain,
  audience: "aud-tag-1",
  sessionSecret: "session-secret-session-secret-32-bytes",
  allowedUsers: "public",
  sessionTtlSeconds: 60,
};

describe("Auth (cloudflare-access)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // One signing key for the whole suite: the JWKS cache is process-global and keyed by
  // the team's JWKS URL, so every token for cfTeamDomain must come from the same key.
  let teamKeyPair: TestKeyPair | undefined;

  /** Points fetch at the team's JWKS and signs an Access assertion with its key. */
  async function accessAssertion(claims: Record<string, unknown> = {}): Promise<{ token: string; keyPair: TestKeyPair }> {
    const keyPair = (teamKeyPair ??= await makeKeyPair());
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const token = await signJwt(keyPair.privateKey, {
      iss: cfTeamDomain,
      aud: [cloudflareConfig.audience],
      sub: "cf-user-1",
      email: "Founder@Example.com",
      exp: nowSeconds() + 600,
      iat: nowSeconds(),
      type: "app",
      ...claims,
    });
    return { token, keyPair };
  }

  test("authenticates browser and API requests from the Access assertion header", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    const currentUser = await Effect.runPromise(auth.currentUser(request({ "cf-access-jwt-assertion": token })));
    expect(currentUser?.email).toBe("founder@example.com");
    expect(currentUser?.id).toBe("cf-user-1");

    const apiUser = await Effect.runPromise(auth.requireApiUser(request({ "cf-access-jwt-assertion": token })));
    expect(apiUser.email).toBe("founder@example.com");
  });

  test("applies the allow-list to asserted identities", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth({ ...cloudflareConfig, allowedUsers: "@yc.com" });

    expect(await Effect.runPromise(auth.currentUser(request({ "cf-access-jwt-assertion": token })))).toBeNull();
    await expect(
      Effect.runPromise(auth.requireApiUser(request({ "cf-access-jwt-assertion": token }))),
    ).rejects.toThrow("Authentication required");
  });

  test("requires a credential for API requests", async () => {
    const auth = makeAuth(cloudflareConfig);
    await expect(Effect.runPromise(auth.requireApiUser(request({})))).rejects.toThrow("Authentication required");
  });

  test("still accepts scratchwork bearer session tokens", async () => {
    const token = await Effect.runPromise(createSessionToken(user, cloudflareConfig));
    const auth = makeAuth(cloudflareConfig);

    const apiUser = await Effect.runPromise(auth.requireApiUser(request({ authorization: `Bearer ${token}` })));
    expect(apiUser.email).toBe("founder@example.com");
  });

  test("a stale bearer token falls back to a valid Access assertion", async () => {
    // A bearer signed with a rotated secret must not lock out a request that also
    // carries a verifiable Access assertion.
    const staleBearer = await Effect.runPromise(
      createSessionToken(user, { ...cloudflareConfig, sessionSecret: "rotated-secret-rotated-secret-32-bytes" }),
    );
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    const apiUser = await Effect.runPromise(
      auth.requireApiUser(request({ authorization: `Bearer ${staleBearer}`, "cf-access-jwt-assertion": token })),
    );
    expect(apiUser.email).toBe("founder@example.com");
  });

  test("login hands the CLI loopback a one-time code that redeems to a working bearer token", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    const response = await Effect.runPromise(auth.login(
      request({ "cf-access-jwt-assertion": token }),
      await cliLoginUrl("https://app.scratch.test"),
      "https://app.scratch.test",
    ));

    const location = new URL(HttpServerResponse.toWeb(response).headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("http://127.0.0.1:5555");
    expect(location.searchParams.get("state")).toBe("cli-state-1");
    // The loopback query carries only the one-time code: the bearer token and the
    // relayed Access JWT ride the signed code payload to the back-channel exchange.
    expect(location.searchParams.get("token")).toBeNull();
    expect(location.searchParams.get("cf_token")).toBeNull();

    const payload = await Effect.runPromise(
      decodeCliAuthorizationCode(location.searchParams.get("code") ?? "", cloudflareConfig),
    );
    expect(payload.provider).toBe("cloudflare-access");
    // The verified Access JWT is relayed inside the signed payload so the CLI can
    // pass the edge on API requests after the exchange.
    expect(payload.cfToken).toBe(token);
    const redeemed = await Effect.runPromise(
      verifyCliCodeExchange(payload, CLI_VERIFIER, "http://127.0.0.1:5555/callback", cloudflareConfig),
    );
    const bearer = await Effect.runPromise(createSessionToken(redeemed, cloudflareConfig));
    const apiUser = await Effect.runPromise(auth.requireApiUser(request({ authorization: `Bearer ${bearer}` })));
    expect(apiUser.email).toBe("founder@example.com");
  });

  test("browser login without a CLI redirect relays nothing", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    const response = await Effect.runPromise(auth.login(
      request({ "cf-access-jwt-assertion": token }),
      new URL("https://app.scratch.test/auth/login?returnTo=%2Fhome"),
      "https://app.scratch.test",
    ));

    expect(HttpServerResponse.toWeb(response).headers.get("location")).toBe("/home");
  });

  test("accepts the relayed JWT from the cf-access-token header", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    const currentUser = await Effect.runPromise(auth.currentUser(request({ "cf-access-token": token })));
    expect(currentUser?.email).toBe("founder@example.com");

    const apiUser = await Effect.runPromise(auth.requireApiUser(request({ "cf-access-token": token })));
    expect(apiUser.email).toBe("founder@example.com");
  });

  test("the edge-injected assertion wins over cf-access-token when both are present", async () => {
    const { token } = await accessAssertion();
    const auth = makeAuth(cloudflareConfig);

    // A garbage relayed header cannot displace a valid assertion...
    const apiUser = await Effect.runPromise(auth.requireApiUser(
      request({ "cf-access-jwt-assertion": token, "cf-access-token": "garbage" }),
    ));
    expect(apiUser.email).toBe("founder@example.com");

    // ...and a valid relayed header never rescues a bad assertion: the edge-verified
    // header is authoritative when present.
    expect(await Effect.runPromise(auth.currentUser(
      request({ "cf-access-jwt-assertion": "garbage", "cf-access-token": token }),
    ))).toBeNull();
  });

  test("rejects an invalid cf-access-token", async () => {
    await accessAssertion(); // primes the JWKS mock for the verification attempt
    const auth = makeAuth(cloudflareConfig);

    expect(await Effect.runPromise(auth.currentUser(request({ "cf-access-token": "garbage" })))).toBeNull();
    await expect(
      Effect.runPromise(auth.requireApiUser(request({ "cf-access-token": "garbage" }))),
    ).rejects.toThrow();
  });

  test("login without an Access assertion fails loudly", async () => {
    const auth = makeAuth(cloudflareConfig);
    await expect(Effect.runPromise(auth.login(
      request({}),
      new URL("https://app.scratch.test/auth/login"),
      "https://app.scratch.test",
    ))).rejects.toThrow("Cloudflare Access did not authenticate this request");
  });

  test("there is no OAuth callback", async () => {
    const auth = makeAuth(cloudflareConfig);
    await expect(Effect.runPromise(auth.callback(
      request({}),
      new URL("https://app.scratch.test/auth/callback/google?code=x&state=y"),
      "https://app.scratch.test",
    ))).rejects.toThrow("no OAuth callback");
  });

  test("logout redirects to Cloudflare's edge logout endpoint", () => {
    const auth = makeAuth(cloudflareConfig);
    const response = HttpServerResponse.toWeb(auth.logout("https://app.scratch.test"));
    expect(response.headers.get("location")).toBe("/cdn-cgi/access/logout");
  });
});

describe("readServerConfig", () => {
  test("reads OAuth settings from environment", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_AUTH: "oauth",
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_AUTH_ALLOWED_DOMAINS: "example.com, yc.com",
      }),
    );

    expect(config.auth.allowedUsers).toBe("@example.com,@yc.com");
  });

  test("rejects unknown auth modes", async () => {
    await expect(
      Effect.runPromise(
        readServerConfig({
          SCRATCHWORK_AUTH: "google",
          SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
          SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
          SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        }),
      ),
    ).rejects.toThrow('Invalid SCRATCHWORK_AUTH "google": expected "oauth" or "cloudflare-access"');
  });

  test("fails when no auth mode is chosen", async () => {
    await expect(Effect.runPromise(readServerConfig({}))).rejects.toThrow(
      'SCRATCHWORK_AUTH is required: set it to "oauth" or "cloudflare-access"',
    );
  });

  test("fails without OAuth credentials", async () => {
    await expect(Effect.runPromise(readServerConfig({ SCRATCHWORK_AUTH: "oauth" }))).rejects.toThrow(
      "OAuth mode requires",
    );
  });

  test("reads Cloudflare Access settings and normalizes the team domain", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_AUTH: "cloudflare-access",
        SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: "myteam",
        SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_ALLOWED_USERS: "@example.com",
      }),
    );

    expect(config.auth.mode).toBe("cloudflare-access");
    if (config.auth.mode !== "cloudflare-access") throw new Error("unreachable");
    expect(config.auth.teamDomain).toBe("https://myteam.cloudflareaccess.com");
    expect(config.auth.audience).toBe("aud-tag-1");
    expect(config.auth.allowedUsers).toBe("@example.com");

    // Full and bare forms of the team domain normalize the same way.
    for (const value of ["myteam.cloudflareaccess.com", "https://myteam.cloudflareaccess.com"]) {
      const alternate = await Effect.runPromise(
        readServerConfig({
          SCRATCHWORK_AUTH: "cloudflare-access",
          SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: value,
          SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
          SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        }),
      );
      if (alternate.auth.mode !== "cloudflare-access") throw new Error("unreachable");
      expect(alternate.auth.teamDomain).toBe("https://myteam.cloudflareaccess.com");
    }
  });

  test("never accepts local Access signing keys on a non-loopback app URL", async () => {
    await expect(Effect.runPromise(readServerConfig({
      SCRATCHWORK_AUTH: "cloudflare-access",
      SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: "myteam",
      SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
      SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      SCRATCHWORK_APP_URL: "https://app.example.com",
      SCRATCHWORK_LOCAL_CF_ACCESS_JWKS: JSON.stringify({ keys: [{ kty: "RSA", kid: "local" }] }),
    }))).rejects.toThrow("only when SCRATCHWORK_APP_URL uses a loopback host");
  });

  test("never accepts local OAuth provider endpoints on a non-loopback app URL", async () => {
    await expect(Effect.runPromise(readServerConfig({
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
      SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      SCRATCHWORK_APP_URL: "https://app.example.com",
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:4300/authorize",
      SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL: "http://127.0.0.1:4300/token",
      SCRATCHWORK_LOCAL_OAUTH_JWKS_URL: "http://127.0.0.1:4300/jwks",
    }))).rejects.toThrow("only when SCRATCHWORK_APP_URL uses a loopback host");
  });

  test("local OAuth provider endpoints require all three and loopback URLs", async () => {
    const base = {
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
      SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      SCRATCHWORK_APP_URL: "http://localhost:3001",
    };

    await expect(Effect.runPromise(readServerConfig({
      ...base,
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:4300/authorize",
    }))).rejects.toThrow("Set all of");

    await expect(Effect.runPromise(readServerConfig({
      ...base,
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:4300/authorize",
      SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL: "https://accounts.example.com/token",
      SCRATCHWORK_LOCAL_OAUTH_JWKS_URL: "http://127.0.0.1:4300/jwks",
    }))).rejects.toThrow("a loopback URL");

    const config = await Effect.runPromise(readServerConfig({
      ...base,
      SCRATCHWORK_LOCAL_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:4300/authorize",
      SCRATCHWORK_LOCAL_OAUTH_TOKEN_URL: "http://127.0.0.1:4300/token",
      SCRATCHWORK_LOCAL_OAUTH_JWKS_URL: "http://127.0.0.1:4300/jwks",
    }));
    if (config.auth.mode !== "oauth") throw new Error("unreachable");
    expect(config.auth.localEndpoints).toEqual({
      authorizeUrl: "http://127.0.0.1:4300/authorize",
      tokenUrl: "http://127.0.0.1:4300/token",
      jwksUrl: "http://127.0.0.1:4300/jwks",
    });
  });

  test("fails without the Cloudflare Access settings, without demanding OAuth credentials", async () => {
    await expect(
      Effect.runPromise(readServerConfig({ SCRATCHWORK_AUTH: "cloudflare-access" })),
    ).rejects.toThrow(
      "Cloudflare Access mode requires SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN, SCRATCHWORK_CF_ACCESS_AUD, SCRATCHWORK_SESSION_SECRET",
    );
  });

  test("defaults to user-set project names", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_AUTH: "oauth",
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      }),
    );

    expect(config.usersCanSetProjectNames).toBe(true);
  });

  test("reads the configured project-naming setting", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_AUTH: "oauth",
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "false",
      }),
    );

    expect(config.usersCanSetProjectNames).toBe(false);
  });

  test("rejects non-boolean project-naming values", async () => {
    await expect(
      Effect.runPromise(readServerConfig({
        SCRATCHWORK_AUTH: "oauth",
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "yes",
      })),
    ).rejects.toThrow('Invalid SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES "yes": expected "true" or "false"');
  });
});

/** Fabricates an HttpServerRequest carrying the given headers. */
function request(headers: Record<string, string>): HttpServerRequest.HttpServerRequest {
  return { headers } as HttpServerRequest.HttpServerRequest;
}

/** Decodes a base64url string into bytes. */
function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Signs an arbitrary payload the same way the auth service does, so tests can craft
 * tokens in retired payload shapes. */
async function signLegacyToken(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Encodes bytes as base64url. */
function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
