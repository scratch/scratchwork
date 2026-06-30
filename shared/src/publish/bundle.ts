import { base64ToBytes as decodeBase64, bytesToBase64 } from "../encoding/base64";
import { isRecord } from "../util/json";
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

export { bytesToBase64 };

export function base64ToBytes(contentBase64: string): Uint8Array {
  const bytes = decodeBase64(contentBase64);
  if (bytes == null) throw new Error("Invalid base64 content");
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
    if (typeof file.contentBase64 !== "string" || decodeBase64(file.contentBase64) == null) return null;

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
