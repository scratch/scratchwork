/*
 * Lowercase hex encoding and validation, used for content hashes and tokens
 * that travel between the CLI and server.
 */

/** Encodes bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

/** Checks whether a string is non-empty even-length lowercase hex. */
export function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}
