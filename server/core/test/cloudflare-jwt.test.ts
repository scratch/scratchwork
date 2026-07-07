import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { verifyCloudflareAccessToken } from "../src/cloudflare-jwt";
import { jwksFetch, makeKeyPair, nowSeconds as now, signJwt } from "./jwt-helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TEAM_DOMAIN = "https://myteam.cloudflareaccess.com";
const AUDIENCE = "aud-tag-1";

/** Baseline claims of a valid Access application token; Cloudflare sends aud as an array. */
function validClaims(): Record<string, unknown> {
  return {
    iss: TEAM_DOMAIN,
    aud: [AUDIENCE],
    sub: "cf-user-uuid-1",
    email: "founder@example.com",
    exp: now() + 600,
    iat: now(),
    type: "app",
  };
}

describe("verifyCloudflareAccessToken", () => {
  test("accepts a valid Access application token", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const token = await signJwt(keyPair.privateKey, validClaims());

    const claims = await Effect.runPromise(verifyCloudflareAccessToken(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwksUrl: "https://cf-jwks-1.test/certs",
    }));

    expect(claims.email).toBe("founder@example.com");
    expect(claims.sub).toBe("cf-user-uuid-1");
  });

  test("accepts a valid token against a preloaded local JWKS without fetching", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = (async () => {
      throw new Error("local verification must not fetch");
    }) as unknown as typeof fetch;
    const token = await signJwt(keyPair.privateKey, validClaims());

    const claims = await Effect.runPromise(verifyCloudflareAccessToken(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks: [keyPair.publicJwk],
    }));

    expect(claims.email).toBe("founder@example.com");
  });

  test("rejects wrong audiences, wrong issuers, and expired tokens", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const options = { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksUrl: "https://cf-jwks-2.test/certs" };

    const wrongAud = await signJwt(keyPair.privateKey, { ...validClaims(), aud: ["another-application"] });
    await expect(Effect.runPromise(verifyCloudflareAccessToken(wrongAud, options))).rejects.toThrow("audience");

    const wrongIssuer = await signJwt(keyPair.privateKey, { ...validClaims(), iss: "https://other.cloudflareaccess.com" });
    await expect(Effect.runPromise(verifyCloudflareAccessToken(wrongIssuer, options))).rejects.toThrow("issuer");

    const expired = await signJwt(keyPair.privateKey, { ...validClaims(), exp: now() - 3600 });
    await expect(Effect.runPromise(verifyCloudflareAccessToken(expired, options))).rejects.toThrow("Expired");
  });

  test("rejects service tokens, which assert a client ID instead of an email", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const serviceToken = await signJwt(keyPair.privateKey, {
      ...validClaims(),
      email: undefined,
      sub: "",
      common_name: "service-token-client-id",
    });

    await expect(Effect.runPromise(verifyCloudflareAccessToken(serviceToken, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwksUrl: "https://cf-jwks-3.test/certs",
    }))).rejects.toThrow("service tokens are not supported");
  });

  test("rejects tampered payloads", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const token = await signJwt(keyPair.privateKey, validClaims());

    const [header, , signature] = token.split(".");
    const tamperedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
      ...validClaims(),
      email: "attacker@example.com",
    })));

    await expect(Effect.runPromise(verifyCloudflareAccessToken(`${header}.${tamperedPayload}.${signature}`, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwksUrl: "https://cf-jwks-4.test/certs",
    }))).rejects.toThrow("signature");
  });
});
