/*
 * Cross-field validation for POST /api/projects/:project/share. The wire
 * shape is the shared ShareRequestSchema (decoded strictly by the dispatcher
 * in api-routes.ts); target grammar (email vs @domain) and sharing policy are
 * enforced by access.ts and the site store so every access rule lives in one
 * place.
 */
import * as Effect from "effect/Effect";
import type { ShareRequest } from "../../../shared/src/publish/api";
import { HttpError } from "./http";
import type { ShareChanges } from "./site-store";

/** Maximum accepted share request body size. */
export const MAX_SHARE_BODY_BYTES = 64 * 1024;
/** Maximum add + remove targets in one share call. */
export const MAX_SHARE_TARGETS = 100;

/** Normalizes and cross-field-validates a decoded share request body. */
export function validateShareChanges(raw: ShareRequest): Effect.Effect<ShareChanges, HttpError> {
  const changes: ShareChanges = { role: raw.role ?? "read", add: raw.add ?? [], remove: raw.remove ?? [] };
  if (changes.add.length + changes.remove.length === 0) {
    return Effect.fail(new HttpError({ status: 400, message: "Share request must add or remove at least one target" }));
  }
  if (changes.add.length + changes.remove.length > MAX_SHARE_TARGETS) {
    return Effect.fail(new HttpError({ status: 400, message: `Share request exceeds ${MAX_SHARE_TARGETS} targets` }));
  }
  return Effect.succeed(changes);
}
