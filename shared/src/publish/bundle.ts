import { isSafeSitePath, type SitePath } from "../site/paths";

export const PUBLISH_BUNDLE_VERSION = 1;

export interface PublishBundleFile {
  readonly path: SitePath;
  readonly contentBase64: string;
}

export interface PublishBundle {
  readonly version: typeof PUBLISH_BUNDLE_VERSION;
  readonly files: ReadonlyArray<PublishBundleFile>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triplet >> 18) & 63];
    output += BASE64_ALPHABET[(triplet >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] : "=";
  }
  return output;
}

export function base64ToBytes(contentBase64: string): Uint8Array {
  const input = contentBase64.replace(/\s/g, "");
  const padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((input.length * 3) / 4) - padding);
  let byteIndex = 0;

  for (let index = 0; index < input.length; index += 4) {
    const a = base64Value(input[index]);
    const b = base64Value(input[index + 1]);
    const c = input[index + 2] === "=" ? 0 : base64Value(input[index + 2]);
    const d = input[index + 3] === "=" ? 0 : base64Value(input[index + 3]);
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;

    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 16) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triplet >> 8) & 255;
    if (byteIndex < bytes.length) bytes[byteIndex++] = triplet & 255;
  }

  return bytes;
}

export function decodePublishBundle(value: unknown): PublishBundle | null {
  if (!isRecord(value) || value.version !== PUBLISH_BUNDLE_VERSION) {
    return null;
  }
  if (!Array.isArray(value.files)) return null;

  const seen = new Set<string>();
  const files: Array<PublishBundleFile> = [];
  for (const file of value.files) {
    if (!isRecord(file)) return null;
    if (typeof file.path !== "string" || !isSafeSitePath(file.path)) {
      return null;
    }
    if (seen.has(file.path)) return null;
    if (typeof file.contentBase64 !== "string") return null;

    seen.add(file.path);
    files.push({
      path: file.path,
      contentBase64: file.contentBase64,
    });
  }

  return {
    version: PUBLISH_BUNDLE_VERSION,
    files,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Value(character: string | undefined): number {
  if (character == null) return 0;
  const value = BASE64_ALPHABET.indexOf(character);
  return value === -1 ? 0 : value;
}
