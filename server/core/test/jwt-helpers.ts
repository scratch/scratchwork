/**
 * Shared JWT test fixtures: a throwaway RSA key pair, a compact RS256-JWT signer, and a
 * fetch mock serving the matching JWKS document. Used by the google-jwt, cloudflare-jwt,
 * and auth tests. The production JWKS cache is keyed by URL, so tests that generate their
 * own key pair must also use a JWKS URL (or team domain) unique to that key pair.
 */
import * as Encoding from "effect/Encoding";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";

/** A generated RSA signing key with its public JWKS entry. */
export interface TestKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

/** Creates a test RSA key pair and public JWK. */
export async function makeKeyPair(): Promise<TestKeyPair> {
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
export async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "kid-1", typ: "JWT" })));
  const body = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    toArrayBuffer(new TextEncoder().encode(data)),
  );
  return `${data}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
}

/** Returns a fetch mock that serves one JWKS document. */
export function jwksFetch(publicJwk: JsonWebKey & { readonly kid: string }): typeof fetch {
  return (async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    headers: {
      "cache-control": "max-age=60",
      "content-type": "application/json",
    },
  })) as unknown as typeof fetch;
}

/** Returns the current Unix timestamp in seconds for test claims. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
