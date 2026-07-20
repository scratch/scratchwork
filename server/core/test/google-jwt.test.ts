import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import { verifyGoogleIdToken } from "../src/google-jwt";
import { jwksFetch, makeKeyPair, nowSeconds as now, signJwt } from "./jwt-helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("verifyGoogleIdToken", () => {
  test("accepts a valid Google-style RS256 token", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const token = await signJwt(keyPair.privateKey, {
      iss: "https://accounts.google.com",
      aud: "client-id",
      sub: "google-user-1",
      email: "founder@example.com",
      email_verified: true,
      exp: now() + 600,
      iat: now(),
      nonce: "nonce-1",
    });

    const claims = await Effect.runPromise(verifyGoogleIdToken(token, {
      clientId: "client-id",
      expectedNonce: "nonce-1",
      jwksUrl: "https://jwks.test/certs",
    }));

    expect(claims.email).toBe("founder@example.com");
  });

  test("rejects tampered tokens and wrong nonces", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const token = await signJwt(keyPair.privateKey, {
      iss: "https://accounts.google.com",
      aud: "client-id",
      sub: "google-user-1",
      email: "founder@example.com",
      email_verified: true,
      exp: now() + 600,
      nonce: "nonce-1",
    });

    const [header, payload, signature] = token.split(".");
    const tamperedPayload = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "client-id",
      sub: "google-user-1",
      email: "attacker@example.com",
      email_verified: true,
      exp: now() + 600,
      nonce: "nonce-1",
    })));

    await expect(Effect.runPromise(verifyGoogleIdToken(`${header}.${tamperedPayload}.${signature}`, {
      clientId: "client-id",
      expectedNonce: "nonce-1",
      jwksUrl: "https://jwks2.test/certs",
    }))).rejects.toThrow("signature");

    await expect(Effect.runPromise(verifyGoogleIdToken(token, {
      clientId: "client-id",
      expectedNonce: "wrong",
      jwksUrl: "https://jwks2.test/certs",
    }))).rejects.toThrow("nonce");
  });

  test("expectedIssuer replaces the Google issuers exactly", async () => {
    const keyPair = await makeKeyPair();
    globalThis.fetch = jwksFetch(keyPair.publicJwk);
    const issuer = "https://localhost.emobix.co.uk:8443/test/a/scratchwork/";
    const mint = (iss: string) => signJwt(keyPair.privateKey, {
      iss,
      aud: "client-id",
      sub: "user-1",
      email: "founder@example.com",
      email_verified: true,
      exp: now() + 600,
      iat: now(),
      nonce: "nonce-1",
    });
    // Fresh JWKS URL: the verifier caches keys per URL across tests.
    const options = { clientId: "client-id", expectedNonce: "nonce-1", jwksUrl: "https://jwks3.test/certs" };

    // A configured issuer is accepted…
    const claims = await Effect.runPromise(verifyGoogleIdToken(await mint(issuer), { ...options, expectedIssuer: issuer }));
    expect(claims.iss).toBe(issuer);

    // …and replaces Google's, in both directions — no widening.
    await expect(Effect.runPromise(verifyGoogleIdToken(await mint("https://accounts.google.com"), { ...options, expectedIssuer: issuer })))
      .rejects.toThrow("issuer");
    await expect(Effect.runPromise(verifyGoogleIdToken(await mint(issuer), options)))
      .rejects.toThrow("issuer");

    // Prefix/suffix variants of the expected issuer are not the issuer.
    await expect(Effect.runPromise(verifyGoogleIdToken(await mint(issuer.slice(0, -1)), { ...options, expectedIssuer: issuer })))
      .rejects.toThrow("issuer");
    await expect(Effect.runPromise(verifyGoogleIdToken(await mint(`${issuer}extra`), { ...options, expectedIssuer: issuer })))
      .rejects.toThrow("issuer");
  });
});

