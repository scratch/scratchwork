import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { decodedBase64ByteLength } from "../../../shared/src/encoding/base64";
import { PublishRequestBodySchema, type PublishRequestBody } from "../../../shared/src/publish/api";
import { HttpError } from "./http";

/** Maximum accepted request body size (base64-encoded JSON, larger than the content caps). */
export const MAX_PUBLISH_BODY_BYTES = 30 * 1024 * 1024;
/** Maximum number of files in one publish bundle. */
export const MAX_PUBLISH_FILES = 1_000;
/** Maximum decoded size of a single published file. */
export const MAX_PUBLISH_FILE_BYTES = 10 * 1024 * 1024;
/** Maximum decoded size of the whole bundle. */
export const MAX_PUBLISH_TOTAL_BYTES = 25 * 1024 * 1024;

/** A validated publish request: the shared wire body (see the shared api module)
 * plus a normalized `openPath` and the computed decoded bundle size. `project`
 * stays optional at the protocol level — the server mints a name when the naming
 * mode is random, and requires one in the store when publishers choose names. */
export interface PublishRequest extends Omit<PublishRequestBody, "openPath"> {
  readonly openPath: string;
  readonly totalBytes: number;
}

/** Reads, size-limits, parses, and validates a publish request body. */
export function readPublishRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<PublishRequest, HttpError> {
  return Effect.gen(function* () {
    const text = yield* request.text.pipe(
      HttpServerRequest.withMaxBodySize(Option.some(MAX_PUBLISH_BODY_BYTES)),
      Effect.mapError((cause) =>
        new HttpError({ status: 413, message: "Publish body is too large", cause }),
      ),
    );
    if (new TextEncoder().encode(text).byteLength > MAX_PUBLISH_BODY_BYTES) {
      return yield* Effect.fail(new HttpError({ status: 413, message: "Publish body is too large" }));
    }
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(text).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "Invalid JSON body" })),
    );
    return yield* decodePublishRequest(parsed);
  });
}

/** Decodes an unknown JSON value into a normalized publish request. Decoding is
 * deliberately strict — every problem is reported and unknown fields are errors —
 * so protocol drift surfaces as a clear 400 instead of being silently dropped. */
export function decodePublishRequest(value: unknown): Effect.Effect<PublishRequest, HttpError> {
  return Effect.gen(function* () {
    const raw = yield* Schema.decodeUnknown(PublishRequestBodySchema)(value, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) =>
        new HttpError({ status: 400, message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );
    return yield* normalizePublishRequest(raw);
  });
}

/** Applies cross-field publish validation and computes decoded bundle size. */
function normalizePublishRequest(raw: PublishRequestBody): Effect.Effect<PublishRequest, HttpError> {
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
