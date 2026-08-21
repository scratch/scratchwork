/*
 * The adversarial token corpus (AGENTS.md, invariant 3): every signed HMAC
 * token kind — session, oauth-state, cli-code, and project-access in both its
 * handoff and cookie uses — exercised against four properties, each through
 * the token's real production verification path:
 *
 *  - Integrity: a valid token rejects every single-bit flip of any character.
 *  - Typed meaning: correctly signed but malformed payloads reject — missing,
 *    extra, and wrong-typed fields, wrong kind/version/provider/use/project/
 *    scope, boundary and non-finite timestamps, future issuance, and every
 *    cross-kind pairing.
 *  - Parser hardening: truncation, segment games, non-canonical base64url,
 *    non-object JSON, and oversized inputs reject.
 *  - Lifecycle: expiry rejects at its exact boundary; which stateless kinds
 *    remain replayable within their lifetime is asserted explicitly.
 *
 * The test signer below produces byte-identical output to the production
 * signValue chokepoint (same HMAC, same encoding, same secret), which is what
 * lets the corpus craft payloads the server would never mint.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import {
  createMcpAccessToken,
  createMcpConsentToken,
  createMcpRefreshToken,
  createSessionToken,
  decodeCliAuthorizationCode,
  decodeMcpAuthorizationCode,
  issueCliAuthorizationCode,
  issueMcpAuthorizationCode,
  makeAuth,
  verifyMcpAccessToken,
  verifyMcpConsentToken,
  verifyMcpRefreshToken,
  type AuthUser,
} from "../src/auth";
import type { AuthConfig } from "../src/config";

const user: AuthUser = { id: "corpus-user-1", email: "corpus@example.com", name: "Corpus" };

const config: AuthConfig = {
  mode: "oauth",
  clientId: "corpus-client-id",
  clientSecret: "corpus-client-secret",
  sessionSecret: "corpus-session-secret-at-least-32-bytes",
  allowedUsers: "public",
  sessionTtlSeconds: 3600,
};

const auth = makeAuth(config);
const BASE_URL = "https://app.scratch.test";
/** The opaque state parameter crafted oauth-state payloads carry. */
const FIXED_STATE = "corpus-state-param";

const now = () => Math.floor(Date.now() / 1000);

/** Fabricates an HttpServerRequest carrying the given headers. */
function request(headers: Record<string, string>): HttpServerRequest.HttpServerRequest {
  return { headers } as HttpServerRequest.HttpServerRequest;
}

/** Base64url without padding, byte-identical to production signValue. */
function b64u(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs an arbitrary payload segment string exactly as signValue would. */
async function signRaw(payloadSegment: string, secret = config.sessionSecret): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadSegment));
  return `${payloadSegment}.${b64u(new Uint8Array(signature))}`;
}

/** Signs a JSON payload exactly as the production signValue chokepoint does. */
async function craft(payload: unknown, secret = config.sessionSecret): Promise<string> {
  return signRaw(b64u(new TextEncoder().encode(JSON.stringify(payload))), secret);
}

/** Runs a mint function with the clock shifted, so expiry can be minted for real. */
async function withShiftedClock<T>(seconds: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + seconds * 1000;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

/** One token kind: how to mint it for real, its canonical crafted payload, and
 * its acceptance oracle through the production verification path. */
interface TokenKind {
  readonly name: string;
  readonly mint: () => Promise<string>;
  readonly validPayload: () => Record<string, unknown>;
  readonly accepts: (token: string) => Promise<boolean>;
}

/** oauth-state verifies inside the OAuth callback. The denial leg (`?error=`)
 * exercises the state check without needing a token-endpoint mock: reaching
 * the provider-error branch (an AuthError naming the provider, or a CLI
 * loopback redirect) proves the state token was accepted; failing before it
 * ("Invalid auth token" / "Invalid or expired OAuth state" / missing
 * parameters) proves it was rejected. */
async function oauthStateAccepts(token: string, stateParam: string = FIXED_STATE): Promise<boolean> {
  try {
    const response = await Effect.runPromise(auth.callback(
      request({ cookie: `__Host-scratchwork_oauth_state=${encodeURIComponent(token)}` }),
      new URL(`${BASE_URL}/auth/callback/google?error=access_denied&state=${encodeURIComponent(stateParam)}`),
      BASE_URL,
    ));
    return HttpServerResponse.toWeb(response).status === 302;
  } catch (error) {
    return String(error).includes("Google OAuth failed");
  }
}

const CLI_REDIRECT = "http://127.0.0.1:5555/callback";
/** The MCP resource URL every mcp-access/mcp-refresh oracle verifies against. */
const MCP_AUD = `${BASE_URL}/mcp`;
const MCP_CLIENT_ID = "corpus-mcp-client-1";
const MCP_REDIRECT = "http://127.0.0.1:6060/callback";
const MCP_CHALLENGE = "corpus-challenge-corpus-challenge-corpus-ch1";

const KINDS: readonly TokenKind[] = [
  {
    name: "session",
    mint: () => Effect.runPromise(createSessionToken(user, config)),
    validPayload: () => ({
      version: 1,
      kind: "session",
      provider: "google",
      user: { id: user.id, email: user.email, name: user.name },
      issuedAt: now(),
      expiresAt: now() + 3600,
    }),
    accepts: async (token) =>
      (await Effect.runPromise(auth.currentUser(request({ authorization: `Bearer ${token}` })))) != null,
  },
  {
    name: "oauth-state",
    mint: async () => craft(KINDS[1].validPayload()),
    validPayload: () => ({
      version: 1,
      kind: "oauth-state",
      state: FIXED_STATE,
      nonce: "corpus-nonce",
      codeVerifier: "corpus-verifier-corpus-verifier-corpus-veri1",
      returnTo: "/",
      expiresAt: now() + 600,
    }),
    accepts: (token) => oauthStateAccepts(token),
  },
  {
    name: "cli-code",
    mint: () =>
      Effect.runPromise(issueCliAuthorizationCode(user, {
        provider: "google",
        codeChallenge: "corpus-challenge-corpus-challenge-corpus-ch1",
        redirectUri: CLI_REDIRECT,
      }, config)),
    validPayload: () => ({
      version: 1,
      kind: "cli-code",
      id: "corpus-code-1",
      user: { id: user.id, email: user.email },
      provider: "google",
      codeChallenge: "corpus-challenge-corpus-challenge-corpus-ch1",
      redirectUri: CLI_REDIRECT,
      expiresAt: now() + 60,
    }),
    accepts: (token) =>
      Effect.runPromise(decodeCliAuthorizationCode(token, config)).then(() => true, () => false),
  },
  {
    name: "project-access (handoff)",
    mint: () => Effect.runPromise(auth.issueProjectAccessToken("site", user, "handoff")),
    validPayload: () => ({
      version: 1,
      kind: "project-access",
      use: "handoff",
      project: "site",
      scope: "/site",
      email: user.email,
      expiresAt: now() + 60,
    }),
    accepts: (token) =>
      Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "handoff")).then(
        (found) => found != null,
        () => false,
      ),
  },
  {
    name: "project-access (cookie)",
    mint: () => Effect.runPromise(auth.issueProjectAccessToken("site", user, "cookie")),
    validPayload: () => ({
      version: 1,
      kind: "project-access",
      use: "cookie",
      project: "site",
      scope: "/site",
      email: user.email,
      expiresAt: now() + 3600,
    }),
    accepts: (token) =>
      Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "cookie")).then(
        (found) => found != null,
        () => false,
      ),
  },
  {
    name: "mcp-consent",
    mint: () =>
      Effect.runPromise(createMcpConsentToken({
        clientId: MCP_CLIENT_ID,
        redirectUri: MCP_REDIRECT,
        codeChallenge: MCP_CHALLENGE,
        userId: user.id,
      }, config)),
    validPayload: () => ({
      version: 1,
      kind: "mcp-consent",
      clientId: MCP_CLIENT_ID,
      redirectUri: MCP_REDIRECT,
      codeChallenge: MCP_CHALLENGE,
      userId: user.id,
      expiresAt: now() + 600,
    }),
    accepts: (token) =>
      Effect.runPromise(verifyMcpConsentToken(token, config)).then(() => true, () => false),
  },
  {
    name: "mcp-code",
    mint: () =>
      Effect.runPromise(issueMcpAuthorizationCode(user, {
        clientId: MCP_CLIENT_ID,
        redirectUri: MCP_REDIRECT,
        codeChallenge: MCP_CHALLENGE,
      }, config)),
    validPayload: () => ({
      version: 1,
      kind: "mcp-code",
      id: "corpus-mcp-code-1",
      user: { id: user.id, email: user.email },
      clientId: MCP_CLIENT_ID,
      redirectUri: MCP_REDIRECT,
      codeChallenge: MCP_CHALLENGE,
      expiresAt: now() + 60,
    }),
    accepts: (token) =>
      Effect.runPromise(decodeMcpAuthorizationCode(token, config)).then(() => true, () => false),
  },
  {
    name: "mcp-access",
    mint: () =>
      Effect.runPromise(createMcpAccessToken({ user, clientId: MCP_CLIENT_ID }, MCP_AUD, config)),
    validPayload: () => ({
      version: 1,
      kind: "mcp-access",
      user: { id: user.id, email: user.email },
      clientId: MCP_CLIENT_ID,
      aud: MCP_AUD,
      scope: "mcp",
      issuedAt: now(),
      expiresAt: now() + 3600,
    }),
    accepts: (token) =>
      Effect.runPromise(verifyMcpAccessToken(token, MCP_AUD, config)).then(
        (found) => found != null,
        () => false,
      ),
  },
  {
    name: "mcp-refresh",
    mint: () =>
      Effect.runPromise(createMcpRefreshToken({ user, clientId: MCP_CLIENT_ID }, MCP_AUD, config)),
    validPayload: () => ({
      version: 1,
      kind: "mcp-refresh",
      user: { id: user.id, email: user.email },
      clientId: MCP_CLIENT_ID,
      aud: MCP_AUD,
      scope: "mcp",
      issuedAt: now(),
      expiresAt: now() + 3600,
    }),
    accepts: (token) =>
      Effect.runPromise(verifyMcpRefreshToken(token, MCP_AUD, config)).then(
        (found) => found != null,
        () => false,
      ),
  },
];

describe("token corpus: sanity", () => {
  for (const kind of KINDS) {
    test(`${kind.name}: the minted token verifies`, async () => {
      expect(await kind.accepts(await kind.mint())).toBe(true);
    });
    test(`${kind.name}: the crafted canonical payload verifies (signer parity)`, async () => {
      expect(await kind.accepts(await craft(kind.validPayload()))).toBe(true);
    });
  }

  test("a real OAuth login's state cookie verifies through the callback", async () => {
    const login = HttpServerResponse.toWeb(await Effect.runPromise(auth.login(
      request({}),
      new URL(`${BASE_URL}/auth/login`),
      BASE_URL,
    )));
    const stateParam = new URL(login.headers.get("location") ?? "https://invalid").searchParams.get("state") ?? "";
    const setCookie = login.headers.get("set-cookie") ?? "";
    const pair = setCookie.split(";")[0] ?? "";
    const token = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
    expect(await oauthStateAccepts(token, stateParam)).toBe(true);
  });
});

describe("token corpus: integrity", () => {
  for (const kind of KINDS) {
    test(`${kind.name}: rejects every single-bit flip`, async () => {
      const token = await kind.mint();
      const survivors: string[] = [];
      for (let index = 0; index < token.length; index++) {
        for (let bit = 0; bit < 8; bit++) {
          const flipped =
            token.slice(0, index) +
            String.fromCharCode(token.charCodeAt(index) ^ (1 << bit)) +
            token.slice(index + 1);
          if (await kind.accepts(flipped)) survivors.push(`char ${index} bit ${bit}`);
        }
      }
      expect(survivors).toEqual([]);
    }, 60_000);

    test(`${kind.name}: rejects the same payload signed with a different secret`, async () => {
      expect(await kind.accepts(await craft(kind.validPayload(), "other-secret-other-secret-32-bytes!!!"))).toBe(false);
    });
  }
});

describe("token corpus: typed meaning", () => {
  test("every cross-kind pairing rejects", async () => {
    for (const payloadKind of KINDS) {
      for (const verifier of KINDS) {
        if (payloadKind.name === verifier.name) continue;
        const token = await craft(payloadKind.validPayload());
        expect({ pair: `${payloadKind.name} → ${verifier.name}`, accepted: await verifier.accepts(token) }).toEqual({
          pair: `${payloadKind.name} → ${verifier.name}`,
          accepted: false,
        });
      }
    }
  });

  for (const kind of KINDS) {
    test(`${kind.name}: rejects each field missing, wrong-typed, or unknown`, async () => {
      const payload = kind.validPayload();
      const cases: Array<{ label: string; payload: Record<string, unknown> }> = [];
      for (const field of Object.keys(payload)) {
        const { [field]: _dropped, ...rest } = payload;
        cases.push({ label: `missing ${field}`, payload: rest });
        cases.push({ label: `wrong-typed ${field}`, payload: { ...payload, [field]: {} } });
      }
      cases.push({ label: "unknown extra field", payload: { ...payload, admin: true } });
      cases.push({ label: "version 0", payload: { ...payload, version: 0 } });
      cases.push({ label: "version 2", payload: { ...payload, version: 2 } });
      cases.push({ label: 'version "1"', payload: { ...payload, version: "1" } });
      cases.push({ label: "uppercased kind", payload: { ...payload, kind: String(payload.kind).toUpperCase() } });
      for (const item of cases) {
        expect({ label: item.label, accepted: await kind.accepts(await craft(item.payload)) }).toEqual({
          label: item.label,
          accepted: false,
        });
      }
    });

    test(`${kind.name}: rejects boundary and non-finite timestamps`, async () => {
      const payload = kind.validPayload();
      for (const expiresAt of [0, -1, now(), now() - 1]) {
        expect(await kind.accepts(await craft({ ...payload, expiresAt }))).toBe(false);
      }
      // JSON.stringify cannot emit 1e999, so splice the literal into the wire
      // form: it parses to Infinity, which must fail the finite() constraint
      // rather than mint an eternal token.
      const marker = 987654321098765;
      const json = JSON.stringify({ ...payload, expiresAt: marker }).replace(String(marker), "1e999");
      expect(await kind.accepts(await signRaw(b64u(new TextEncoder().encode(json))))).toBe(false);
      // Just inside the lifetime still verifies, so the boundary is exact.
      expect(await kind.accepts(await craft({ ...payload, expiresAt: now() + 5 }))).toBe(true);
    });
  }

  test("session: rejects future issuance beyond clock skew", async () => {
    const payload = KINDS[0].validPayload();
    expect(await KINDS[0].accepts(await craft({ ...payload, issuedAt: now() + 3600 }))).toBe(false);
    expect(await KINDS[0].accepts(await craft({ ...payload, issuedAt: now() + 5 }))).toBe(true);
  });

  test("session: rejects an unknown provider", async () => {
    expect(await KINDS[0].accepts(await craft({ ...KINDS[0].validPayload(), provider: "github" }))).toBe(false);
  });

  test("cli-code: rejects an unknown provider", async () => {
    expect(await KINDS[2].accepts(await craft({ ...KINDS[2].validPayload(), provider: "okta" }))).toBe(false);
  });

  test("project-access: rejects wrong use, project, and scope", async () => {
    const handoff = KINDS[3];
    const payload = handoff.validPayload();
    expect(await handoff.accepts(await craft({ ...payload, use: "cookie" }))).toBe(false);
    expect(await handoff.accepts(await craft({ ...payload, use: "admin" }))).toBe(false);
    expect(await handoff.accepts(await craft({ ...payload, project: "other" }))).toBe(false);
    expect(await handoff.accepts(await craft({ ...payload, scope: "/other" }))).toBe(false);
  });

  test("oauth-state: rejects a state parameter that does not match the payload", async () => {
    const token = await craft(KINDS[1].validPayload());
    expect(await oauthStateAccepts(token, "different-state-param")).toBe(false);
  });

  test("mcp-access and mcp-refresh: reject a token bound to a different audience", async () => {
    const otherAud = "https://other.scratch.test/mcp";
    for (const kind of [KINDS[7], KINDS[8]]) {
      // A token minted for another resource URL fails here...
      expect(await kind.accepts(await craft({ ...kind.validPayload(), aud: otherAud }))).toBe(false);
    }
    // ...and a token minted for this resource fails at another resource.
    const minted = await Effect.runPromise(
      createMcpAccessToken({ user, clientId: MCP_CLIENT_ID }, MCP_AUD, config),
    );
    const elsewhere = await Effect.runPromise(verifyMcpAccessToken(minted, otherAud, config));
    expect(elsewhere).toBeNull();
  });

  test("mcp-access and mcp-refresh: reject a scope other than the literal", async () => {
    for (const kind of [KINDS[7], KINDS[8]]) {
      for (const scope of ["admin", "mcp mcp", "", "MCP"]) {
        expect({ scope, accepted: await kind.accepts(await craft({ ...kind.validPayload(), scope })) }).toEqual({
          scope,
          accepted: false,
        });
      }
    }
  });

  test("mcp-access and mcp-refresh: reject future issuance beyond clock skew", async () => {
    for (const kind of [KINDS[7], KINDS[8]]) {
      expect(await kind.accepts(await craft({ ...kind.validPayload(), issuedAt: now() + 3600 }))).toBe(false);
      expect(await kind.accepts(await craft({ ...kind.validPayload(), issuedAt: now() + 5 }))).toBe(true);
    }
  });
});

describe("token corpus: parser hardening", () => {
  // The parser is the shared verifySignedValue chokepoint; the project-access
  // oracle hands it the raw token string with no transport parsing in front
  // (a bearer header would first normalize whitespace around the token), and
  // the cross-kind suite proves every kind shares the same parser.
  const accepts = (token: string) => KINDS[4].accepts(token);

  test("rejects malformed token structures", async () => {
    const valid = await KINDS[4].mint();
    const [payload, signature] = valid.split(".");
    const malformed: Array<{ label: string; token: string }> = [
      { label: "empty string", token: "" },
      { label: "lone delimiter", token: "." },
      { label: "double delimiter", token: ".." },
      { label: "payload only", token: payload },
      { label: "payload with trailing dot", token: `${payload}.` },
      { label: "signature only", token: `.${signature}` },
      { label: "swapped segments", token: `${signature}.${payload}` },
      { label: "extra segment", token: `${valid}.extra` },
      { label: "duplicated delimiter inside", token: `${payload}..${signature}` },
      { label: "prefix garbage", token: `x${valid}` },
      { label: "suffix garbage", token: `${valid}x` },
      { label: "leading whitespace", token: ` ${valid}` },
      { label: "internal whitespace", token: valid.replace(".", " .") },
      { label: "unicode garbage", token: "🎫🎫.🎫🎫" },
      { label: "oversized input", token: `${"x".repeat(20_000)}.${signature}` },
    ];
    for (const item of malformed) {
      expect({ label: item.label, accepted: await accepts(item.token) }).toEqual({
        label: item.label,
        accepted: false,
      });
    }
  });

  test("rejects non-canonical base64url payload encodings of a valid payload", async () => {
    const payloadJson = JSON.stringify(KINDS[4].validPayload());
    const canonical = b64u(new TextEncoder().encode(payloadJson));
    expect(await accepts(await signRaw(canonical))).toBe(true);
    // Padded form of the same bytes, correctly signed.
    const padded = canonical + "=".repeat((4 - (canonical.length % 4)) % 4 || 2);
    expect(await accepts(await signRaw(padded))).toBe(false);
    // Standard-alphabet form of the same bytes, correctly signed.
    const standard = btoa(String.fromCharCode(...new TextEncoder().encode(payloadJson)));
    if (standard !== canonical) {
      expect(await accepts(await signRaw(standard))).toBe(false);
    }
  });

  test("rejects correctly signed non-object and non-JSON payload segments", async () => {
    for (const segment of ["null", "[]", '"session"', "{}", "{", "42", ""]) {
      const token = await signRaw(b64u(new TextEncoder().encode(segment)));
      expect({ segment, accepted: await accepts(token) }).toEqual({ segment, accepted: false });
    }
    // A payload segment that is not base64url at all, correctly signed.
    expect(await accepts(await signRaw("!!!not-base64url!!!"))).toBe(false);
  });
});

describe("token corpus: lifecycle", () => {
  test("session: a token minted in the past rejects once its TTL elapses", async () => {
    const expired = await withShiftedClock(-(config.sessionTtlSeconds + 60), () =>
      Effect.runPromise(createSessionToken(user, config)));
    expect(await KINDS[0].accepts(expired)).toBe(false);
  });

  test("cli-code: expires after its ~60s window", async () => {
    const expired = await withShiftedClock(-120, () => KINDS[2].mint());
    expect(await KINDS[2].accepts(expired)).toBe(false);
  });

  test("project-access handoff: expires after its ~60s window", async () => {
    const expired = await withShiftedClock(-120, () => KINDS[3].mint());
    expect(await KINDS[3].accepts(expired)).toBe(false);
  });

  test("oauth-state: expires after the state TTL", async () => {
    expect(await KINDS[1].accepts(await craft({ ...KINDS[1].validPayload(), expiresAt: now() - 1 }))).toBe(false);
  });

  test("mcp-consent: expires after the consent TTL", async () => {
    const expired = await withShiftedClock(-(600 + 60), () => KINDS[5].mint());
    expect(await KINDS[5].accepts(expired)).toBe(false);
  });

  test("mcp-code: expires after its ~60s window", async () => {
    const expired = await withShiftedClock(-120, () => KINDS[6].mint());
    expect(await KINDS[6].accepts(expired)).toBe(false);
  });

  test("mcp-access: expires after its one-hour TTL", async () => {
    const expired = await withShiftedClock(-(3600 + 60), () => KINDS[7].mint());
    expect(await KINDS[7].accepts(expired)).toBe(false);
  });

  test("mcp-refresh: expires after the session TTL", async () => {
    const expired = await withShiftedClock(-(config.sessionTtlSeconds + 60), () => KINDS[8].mint());
    expect(await KINDS[8].accepts(expired)).toBe(false);
  });

  test("stateless kinds are replayable within their lifetime — by design", async () => {
    // Documented accepted trade-off (AGENTS.md invariant 3): sessions,
    // project-access tokens, and MCP access/refresh tokens are stateless HMAC,
    // so a token verifies any number of times until expiry or an allow-list /
    // SESSION_VERSION / MCP_TOKEN_VERSION revocation. The cli-code and
    // mcp-code kinds are the deliberate exceptions: their one-time redemption
    // records live in PrimitiveDb at their exchange routes (exercised in
    // server/core/test/app.test.ts, mcp-oauth.test.ts, and the e2e
    // auth-negative lanes), not in the stateless decode exercised here.
    for (const kind of [KINDS[0], KINDS[3], KINDS[4], KINDS[7], KINDS[8]]) {
      const token = await kind.mint();
      expect(await kind.accepts(token)).toBe(true);
      expect(await kind.accepts(token)).toBe(true);
    }
  });
});
