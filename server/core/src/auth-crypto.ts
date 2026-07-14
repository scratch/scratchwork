/**
 * Web Crypto primitives for the auth service: HMAC-SHA256 signing of auth
 * tokens and AES-GCM protection of relayed credentials.
 *
 * This module is a deliberate Promise boundary under invariant 1: Web Crypto
 * inherently returns Promises, so the async lives here — tiny and auditable —
 * and auth.ts (which stays subject to the Effect-only lint) wraps each helper
 * exactly once with Effect.tryPromise. Signing stays a chokepoint (invariant
 * 3): only auth.ts's signValue/verifySignedValue may call hmacSha256Base64Url.
 */
import * as Either from "effect/Either";
import * as Encoding from "effect/Encoding";

/** Computes a base64url HMAC-SHA256 signature for signed auth values. */
export async function hmacSha256Base64Url(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Encoding.encodeBase64Url(new Uint8Array(signature));
}

/** Encrypts one credential with a key derived from the session secret. The random
 * 96-bit IV is prefixed to the AES-GCM ciphertext and encoded as base64url. */
export async function encryptCredential(value: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await credentialEncryptionKey(secret, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  ));
  const encoded = new Uint8Array(iv.length + encrypted.length);
  encoded.set(iv);
  encoded.set(encrypted, iv.length);
  return Encoding.encodeBase64Url(encoded);
}

/** Decrypts a credential produced by encryptCredential. */
export async function decryptCredential(value: string, secret: string): Promise<string> {
  const encoded = Either.getOrNull(Encoding.decodeBase64Url(value));
  if (encoded == null || encoded.length <= 12) throw new Error("invalid encrypted credential");
  const iv = encoded.slice(0, 12);
  const ciphertext = encoded.slice(12);
  const key = await credentialEncryptionKey(secret, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/** Derives the fixed-width AES key without using the session secret as raw AES input. */
async function credentialEncryptionKey(
  secret: string,
  usages: ReadonlyArray<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [...usages]);
}
