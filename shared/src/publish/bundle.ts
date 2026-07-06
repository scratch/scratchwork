/*
 * The publish-bundle wire format: the JSON body the CLI sends to the server's
 * publish endpoint. Both sides use decodePublishBundle as the single
 * definition of what a valid bundle is.
 */
import { base64ToBytes } from "../encoding/base64";
import { isRecord } from "../util/json";
import { isSafeSitePath, type SitePath } from "../site/paths";

/** Version number both sides must agree on before reading a bundle. */
export const PUBLISH_BUNDLE_VERSION = 1;

/** One file in a bundle: its site-relative path and base64-encoded content. */
export interface PublishBundleFile {
  readonly path: SitePath;
  readonly contentBase64: string;
}

/** A complete publish upload: format version plus every file in the site. */
export interface PublishBundle {
  readonly version: typeof PUBLISH_BUNDLE_VERSION;
  readonly files: ReadonlyArray<PublishBundleFile>;
}

/**
 * Validates an untrusted JSON value as a publish bundle. Returns null unless
 * the version matches and every file has a safe, unique path and valid
 * base64 content.
 */
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
    if (typeof file.contentBase64 !== "string" || base64ToBytes(file.contentBase64) == null) return null;

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
