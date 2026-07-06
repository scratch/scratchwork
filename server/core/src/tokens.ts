import { bytesToBase64Url } from "../../../shared/src/encoding/base64";

/** Slug alphabet without ambiguous characters (no 0/1/i/l/o), safe to read aloud or retype. */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;
const REVISION_BYTES = 16;

/** Generates a random project name for servers that assign names on first publish. */
export function randomSlug(): string {
  return randomAlphabetString(SLUG_LENGTH, SLUG_ALPHABET);
}

/** Generates a random revision identifier for immutable site revisions. */
export function randomRevisionId(): string {
  return bytesToBase64Url(randomBytes(REVISION_BYTES));
}

/** Compares two strings in constant time per character; unequal lengths return false immediately. */
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
