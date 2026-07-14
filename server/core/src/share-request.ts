/*
 * Body validation for POST /api/projects/:project/share. Only the shape is checked
 * here; target grammar (email vs @domain) and sharing policy are enforced by
 * access.ts and the site store so every access rule lives in one place.
 */
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { HttpError } from "./http";
import type { ShareChanges } from "./site-store";

/** Maximum accepted share request body size. */
export const MAX_SHARE_BODY_BYTES = 64 * 1024;
/** Maximum add + remove targets in one share call. */
export const MAX_SHARE_TARGETS = 100;

const ShareTargetSchema = Schema.String.pipe(
  Schema.filter((value) => value.trim() !== "" || "Share targets must be non-empty"),
);

const RawShareRequestSchema = Schema.Struct({
  role: Schema.optional(Schema.Literal("read", "write", "admin")),
  add: Schema.optional(Schema.Array(ShareTargetSchema)),
  remove: Schema.optional(Schema.Array(ShareTargetSchema)),
});

/** Reads, size-limits, parses, and validates a share request body. */
export function readShareRequest(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<ShareChanges, HttpError> {
  return Effect.gen(function* () {
    const text = yield* request.text.pipe(
      HttpServerRequest.withMaxBodySize(Option.some(MAX_SHARE_BODY_BYTES)),
      Effect.mapError((cause) => new HttpError({ status: 413, message: "Share body is too large", cause })),
    );
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(text).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "Invalid JSON body" })),
    );
    const raw = yield* Schema.decodeUnknown(RawShareRequestSchema)(parsed, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((error) =>
        new HttpError({ status: 400, message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );
    const changes: ShareChanges = { role: raw.role ?? "read", add: raw.add ?? [], remove: raw.remove ?? [] };
    if (changes.add.length + changes.remove.length === 0) {
      return yield* Effect.fail(new HttpError({ status: 400, message: "Share request must add or remove at least one target" }));
    }
    if (changes.add.length + changes.remove.length > MAX_SHARE_TARGETS) {
      return yield* Effect.fail(new HttpError({ status: 400, message: `Share request exceeds ${MAX_SHARE_TARGETS} targets` }));
    }
    return changes;
  });
}
