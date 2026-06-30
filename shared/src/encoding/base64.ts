const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encodes bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes, BASE64_ALPHABET, true);
}

/** Decodes standard base64, returning null for invalid input. */
export function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/\s/g, "");
  if (!isBase64(normalized)) return null;
  return decodeBase64(normalized, BASE64_ALPHABET);
}

/** Encodes bytes as unpadded URL-safe base64. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes, BASE64_URL_ALPHABET, false);
}

/** Decodes URL-safe base64, returning null for invalid input. */
export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!isBase64(padded)) return null;
  return decodeBase64(padded, BASE64_ALPHABET);
}

/** Computes decoded standard-base64 byte length without allocating the bytes. */
export function decodedBase64ByteLength(value: string): number | null {
  const normalized = value.replace(/\s/g, "");
  if (!isBase64(normalized)) return null;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

/** Encodes bytes with the requested base64 alphabet and padding mode. */
function encodeBase64(bytes: Uint8Array, alphabet: string, padding: boolean): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (index + 1 < bytes.length) {
      output += alphabet[(triplet >> 6) & 63];
    } else if (padding) {
      output += "=";
    }
    if (index + 2 < bytes.length) {
      output += alphabet[triplet & 63];
    } else if (padding) {
      output += "=";
    }
  }
  return output;
}

/** Decodes already-validated base64 using the requested alphabet. */
function decodeBase64(value: string, alphabet: string): Uint8Array {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4) - padding);
  let byteIndex = 0;

  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]);
    const b = alphabet.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : alphabet.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : alphabet.indexOf(value[index + 3]);
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;

    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 16) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 8) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = triplet & 255;
  }

  return bytes;
}

/** Validates standard padded base64 syntax. */
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const firstPadding = value.indexOf("=");
  const contentEnd = firstPadding === -1 ? value.length : firstPadding;
  const padding = firstPadding === -1 ? 0 : value.length - firstPadding;
  if (padding > 2) return false;
  for (let index = 0; index < contentEnd; index++) {
    if (BASE64_ALPHABET.indexOf(value[index]) === -1) return false;
  }
  for (let index = contentEnd; index < value.length; index++) {
    if (value[index] !== "=") return false;
  }
  return true;
}
