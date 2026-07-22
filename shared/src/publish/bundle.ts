/*
 * The publish-bundle wire format: the JSON body the CLI sends to the server's
 * publish endpoint. PublishBundleSchema is the single definition of what a
 * valid bundle is — the server decodes uploads through it (via the publish
 * request schema in api.ts) and the CLI decodes clone downloads through it.
 */
import * as Schema from "effect/Schema";
import { decodedBase64ByteLength } from "../encoding/base64.ts";
import { isSafeSitePath } from "../site/paths.ts";

/** Version number both sides must agree on before reading a bundle. */
export const PUBLISH_BUNDLE_VERSION = 1;

/** One file in a bundle: a safe site-relative path plus base64 content. */
export const PublishBundleFileSchema = Schema.Struct({
  path: Schema.String.pipe(
    Schema.filter((path) => isSafeSitePath(path) || "Invalid site path"),
  ),
  contentBase64: Schema.String.pipe(
    Schema.filter((content) => decodedBase64ByteLength(content) != null || "Invalid base64 content"),
  ),
});

/** A complete publish upload: format version plus every file in the site,
 * each under a unique path. */
export const PublishBundleSchema = Schema.Struct({
  version: Schema.Literal(PUBLISH_BUNDLE_VERSION),
  files: Schema.Array(PublishBundleFileSchema).pipe(
    Schema.filter((files) => {
      const seen = new Set<string>();
      for (const file of files) {
        if (seen.has(file.path)) return `Duplicate file path: ${file.path}`;
        seen.add(file.path);
      }
      return true;
    }),
  ),
});

/** One decoded bundle file. */
export type PublishBundleFile = typeof PublishBundleFileSchema.Type;

/** A decoded publish bundle. */
export type PublishBundle = typeof PublishBundleSchema.Type;
