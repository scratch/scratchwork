/*
 * Byte-buffer conversion helpers shared by any code that hands bytes to Web
 * APIs (crypto, Response bodies) that reject Uint8Array views. Deliberately
 * retained under invariant 1: effect/Encoding covers codecs, not BufferSource
 * conversion, so there is no Effect equivalent to delegate to.
 */

/** Copies a Uint8Array view into an ArrayBuffer accepted by Web Crypto. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
