import * as Effect from "effect/Effect";
import { bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";
import { bytesToHex } from "../../../shared/src/encoding/hex";
import { StorageError } from "./storage";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;
const TOKEN_BYTES = 32;
const REVISION_BYTES = 16;
const RESERVED_SLUGS = new Set(["api", "auth", "health", "favicon.ico", "favicon.svg"]);

/** Generates a human-safe random publish slug. */
export function randomSlug(): string {
  return randomAlphabetString(SLUG_LENGTH, SLUG_ALPHABET);
}

/** Generates a random revision identifier for immutable site revisions. */
export function randomRevisionId(): string {
  return bytesToBase64Url(randomBytes(REVISION_BYTES));
}

/** Generates a URL-safe publish token returned to the CLI. */
export function randomToken(): string {
  return bytesToBase64Url(randomBytes(TOKEN_BYTES));
}

/** Checks whether a slug is syntactically safe and not route-reserved. */
export function safeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Checks whether a publish token uses the expected URL-safe format. */
export function safeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(token);
}

/** Hashes a publish token for storage without keeping plaintext. */
export function tokenHash(token: string): Effect.Effect<string, StorageError> {
  return sha256Hex(new TextEncoder().encode(token)).pipe(
    Effect.map((hash) => `sha256:${hash}`),
    Effect.mapError((cause) =>
      cause instanceof StorageError
        ? new StorageError({ message: "Could not hash publish token", cause })
        : cause,
    ),
  );
}

/** Computes a SHA-256 digest as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): Effect.Effect<string, StorageError> {
  return Effect.tryPromise({
    try: async () => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)))),
    catch: (cause) => new StorageError({ message: "Could not hash bytes", cause }),
  });
}

/** Compares two same-length strings without early exits. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** Maps random bytes into a fixed alphabet. */
function randomAlphabetString(length: number, alphabet: string): string {
  const bytes = randomBytes(length);
  let value = "";
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value;
}

/** Fills a byte array with Web Crypto randomness. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
