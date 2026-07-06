/*
 * Byte-buffer conversion helpers shared by any code that hands bytes to Web
 * APIs (crypto, Response bodies) that reject Uint8Array views.
 */

/** Copies a Uint8Array view into an ArrayBuffer accepted by Web Crypto. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
