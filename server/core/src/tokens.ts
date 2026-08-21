import * as Encoding from "effect/Encoding";

/** Slug alphabet without ambiguous characters (no 0/1/i/l/o), safe to read aloud or retype. */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;
const REVISION_BYTES = 16;
const COMMENT_ID_RANDOM_LENGTH = 8;
/** Fixed digit width for the comment-id timestamp prefix; 14 decimal digits of
 * epoch milliseconds stay fixed-width (and therefore byte-ordered) until 5138. */
const COMMENT_ID_TIME_DIGITS = 14;

/** Generates a random project name for servers that assign names on first publish. */
export function randomSlug(): string {
  return randomAlphabetString(SLUG_LENGTH, SLUG_ALPHABET);
}

/** Generates a random revision identifier for immutable site revisions. */
export function randomRevisionId(): string {
  return Encoding.encodeBase64Url(randomBytes(REVISION_BYTES));
}

/** The last comment-id timestamp this process minted, for same-millisecond ties. */
let lastCommentIdTime = 0;

/** Generates a comment identifier whose UTF-8 byte order is creation order:
 * a fixed-width epoch-milliseconds prefix plus a random suffix, so prefix
 * listings return a page's comments oldest-first without a separate index.
 * Same-millisecond mints within one process are nudged forward a millisecond
 * so their order stays creation order too. */
export function randomCommentId(): string {
  lastCommentIdTime = Math.max(Date.now(), lastCommentIdTime + 1);
  const time = String(lastCommentIdTime).padStart(COMMENT_ID_TIME_DIGITS, "0");
  return `${time}-${randomAlphabetString(COMMENT_ID_RANDOM_LENGTH, SLUG_ALPHABET)}`;
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
