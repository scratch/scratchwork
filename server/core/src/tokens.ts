import * as Effect from "effect/Effect";
import { bytesToBase64Url } from "../../../shared/src/encoding/base64";
import { toArrayBuffer } from "../../../shared/src/encoding/bytes";
import { bytesToHex } from "../../../shared/src/encoding/hex";
import { StorageError } from "./storage";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;
const REVISION_BYTES = 16;

/** Generates a human-safe random publish slug. */
export function randomSlug(): string {
  return randomAlphabetString(SLUG_LENGTH, SLUG_ALPHABET);
}

/** Generates a random revision identifier for immutable site revisions. */
export function randomRevisionId(): string {
  return bytesToBase64Url(randomBytes(REVISION_BYTES));
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
