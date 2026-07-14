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
});

