/*
 * SHA-256 digest helpers over Web Crypto, shared by the CLI (PKCE challenge
 * generation) and server (PKCE challenge verification, content hashing).
 *
 * This module is a deliberate Promise boundary under invariant 1: Web Crypto
 * inherently returns Promises, so the async lives here — small and auditable —
 * and callers wrap these helpers exactly once with Effect.tryPromise.
 */
import * as Encoding from "effect/Encoding";
import { toArrayBuffer } from "../encoding/bytes";

/** Computes the base64url SHA-256 digest of a UTF-8 string (PKCE S256). */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Encoding.encodeBase64Url(new Uint8Array(digest));
}

/** Computes the lowercase-hex SHA-256 digest of raw bytes (content hashing). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Encoding.encodeHex(new Uint8Array(digest));
}
