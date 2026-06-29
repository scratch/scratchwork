import { Buffer } from "node:buffer";
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
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(contentBase64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(contentBase64, "base64"));
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
