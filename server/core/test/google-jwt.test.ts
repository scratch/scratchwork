import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";
import { verifyGoogleIdToken } from "../src/google-jwt";

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
    const tamperedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
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

/** Creates a test RSA key pair and public JWK. */
async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid: "kid-1", alg: "RS256", use: "sig" } };
}

/** Signs a test JWT with the generated RSA private key. */
async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "kid-1", typ: "JWT" })));
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    toArrayBuffer(new TextEncoder().encode(data)),
  );
  return `${data}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Returns a fetch mock that serves one JWKS document. */
function jwksFetch(publicJwk: JsonWebKey & { readonly kid: string }): typeof fetch {
  return (async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    headers: {
      "cache-control": "max-age=60",
      "content-type": "application/json",
    },
  })) as unknown as typeof fetch;
}

/** Returns the current Unix timestamp in seconds for test claims. */
function now(): number {
  return Math.floor(Date.now() / 1000);
}
