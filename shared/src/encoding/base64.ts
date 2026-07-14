/*
 * Base64 size arithmetic. The base64 codecs themselves are `effect/Encoding`
 * (encodeBase64/decodeBase64/encodeBase64Url/decodeBase64Url); this module
 * keeps only what Effect has no equivalent for: computing the decoded byte
 * length of standard base64 without allocating the bytes, so size limits can
 * be enforced before (and without) decoding multi-megabyte file contents.
 *
 * Acceptance must stay in agreement with Encoding.decodeBase64 — a value this
 * function sizes is a value the decoder will accept, and vice versa. The
 * conformance test in shared/test/encoding.test.ts pins that property.
 */

/** Standard base64 with optional trailing padding; `=` only at the end. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Computes decoded standard-base64 byte length without allocating the bytes.
 * Returns null for input Encoding.decodeBase64 would reject. */
export function decodedBase64ByteLength(value: string): number | null {
  // Encoding.decodeBase64 strips CR/LF before validating; mirror that.
  const stripped = value.replace(/[\r\n]/g, "");
  if (stripped.length % 4 !== 0 || !BASE64_PATTERN.test(stripped)) return null;
  const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
  return (stripped.length / 4) * 3 - padding;
}
