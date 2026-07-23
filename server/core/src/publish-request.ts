/*
 * Cross-field validation and normalization for POST /api/publish. The wire
 * shape is the shared PublishRequestBodySchema (decoded strictly by the
 * dispatcher in api-routes.ts); this module applies the server's size policy
 * and normalizes the open path.
 */
import * as Effect from "effect/Effect";
import { decodedBase64ByteLength } from "@scratchwork/shared/encoding/base64";
import { type PublishRequestBody } from "@scratchwork/shared/publish/api";
import { HttpError } from "./http.ts";

/** Maximum accepted request body size (base64-encoded JSON, larger than the content caps). */
export const MAX_PUBLISH_BODY_BYTES = 30 * 1024 * 1024;
/** Maximum number of files in one publish bundle. */
export const MAX_PUBLISH_FILES = 1_000;
/** Maximum decoded size of a single published file. */
export const MAX_PUBLISH_FILE_BYTES = 10 * 1024 * 1024;
/** Maximum decoded size of the whole bundle. */
export const MAX_PUBLISH_TOTAL_BYTES = 25 * 1024 * 1024;

/** Site-path prefix reserved for server-provided routes under each project
 * (today the comments API and widget at /:project/__scratchwork/comments).
 * Publishing files under it is rejected so published content can never be
 * shadowed by — or shadow — a server route. */
export const RESERVED_SITE_PREFIX = "__scratchwork";

/** A validated publish request: the shared wire body (see the shared api module)
 * plus a normalized `openPath` and the computed decoded bundle size. `project`
 * stays optional at the protocol level — the server mints a name when the naming
 * mode is random, and requires one in the store when publishers choose names. */
export interface PublishRequest extends Omit<PublishRequestBody, "openPath"> {
  readonly openPath: string;
  readonly totalBytes: number;
}

/** Applies cross-field publish validation and computes decoded bundle size. */
export function normalizePublishRequest(raw: PublishRequestBody): Effect.Effect<PublishRequest, HttpError> {
  return Effect.gen(function* () {
    if (raw.bundle.files.length === 0) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Publish bundle must contain files" }));
    }
    if (raw.bundle.files.length > MAX_PUBLISH_FILES) {
      return yield* Effect.fail(new HttpError({ status: 413, message: "Publish bundle has too many files" }));
    }

    // Path uniqueness and base64 validity are already guaranteed by the shared
    // bundle schema; the size math still needs each file's decoded byte length.
    let totalBytes = 0;
    for (const file of raw.bundle.files) {
      if (file.path === RESERVED_SITE_PREFIX || file.path.startsWith(`${RESERVED_SITE_PREFIX}/`)) {
        return yield* Effect.fail(new HttpError({
          status: 400,
          message: `Reserved site path: ${file.path} ("${RESERVED_SITE_PREFIX}/" is server-owned)`,
        }));
      }
      const bytes = decodedBase64ByteLength(file.contentBase64);
      if (bytes == null) {
        return yield* Effect.fail(new HttpError({ status: 400, message: `Invalid base64 content: ${file.path}` }));
      }
      if (bytes > MAX_PUBLISH_FILE_BYTES) {
        return yield* Effect.fail(new HttpError({ status: 413, message: `Published file is too large: ${file.path}` }));
      }
      totalBytes += bytes;
      if (totalBytes > MAX_PUBLISH_TOTAL_BYTES) {
        return yield* Effect.fail(new HttpError({ status: 413, message: "Publish bundle is too large" }));
      }
    }

    const openPath = normalizeOpenPath(raw.openPath ?? "/");
    if (openPath == null) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Invalid openPath" }));
    }
    return {
      bundle: raw.bundle,
      openPath,
      project: raw.project,
      isPublic: raw.isPublic,
      commentsEnabled: raw.commentsEnabled,
      totalBytes,
    };
  });
}

/** Normalizes the path the published URL should open after upload. */
function normalizeOpenPath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\") || decoded.includes("?") || decoded.includes("#")) return null;
  const normalized = decoded.replace(/\/+/g, "/");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized === "" ? "/" : normalized;
}
