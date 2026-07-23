/**
 * The persisted data model for viewer comments on published pages. Comments are
 * mutable, listable, per-page state, so they live in one PrimitiveDb namespace
 * keyed `{project}/{encodedPage}/{commentId}`: a prefix listing yields one
 * page's comments, and comment ids are creation-time prefixed so key order is
 * creation order. There is no object-storage component — bodies are small and
 * capped. Comments exist only on private projects (publish rejects the
 * comments+public combination), so every commenter identity comes from the
 * project-access cookie flow.
 */
import * as Schema from "effect/Schema";
import { isSafeProjectIdentifier } from "./access.ts";

/** DB namespace of comment records, keyed `{project}/{encodedPage}/{commentId}`. */
export const COMMENTS_NAMESPACE = "comments";

/** Maximum characters in one comment body. */
export const MAX_COMMENT_BODY_CHARS = 5_000;
/** Maximum anchor candidates one comment may carry. */
export const MAX_COMMENT_ANCHORS = 8;
/** Maximum characters in one anchor selector. */
export const MAX_COMMENT_SELECTOR_CHARS = 400;
/** Maximum characters in a normalized page path. */
export const MAX_COMMENT_PAGE_CHARS = 256;

/**
 * One anchor candidate: a CSS selector plus an offset (CSS pixels) from the
 * matched element's top-left corner. Candidates are ordered most specific
 * first — the clicked element, then its ancestors — and always end with a
 * body-relative fallback, so the widget renders at the first selector that
 * still matches and a republished page degrades gracefully instead of losing
 * the comment.
 */
const CommentAnchorSchema = Schema.Struct({
  selector: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_COMMENT_SELECTOR_CHARS),
  ),
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
});

/** Validates one stored (or incoming) comment. The `version` literal gates
 * format migrations, like the site-record schemas. */
const CommentRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  project: Schema.String.pipe(Schema.filter((value) => isSafeProjectIdentifier(value) || "Invalid project")),
  page: Schema.String.pipe(Schema.filter((value) => isSafeCommentPage(value) || "Invalid page path")),
  author: Schema.Struct({ email: Schema.String }),
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_COMMENT_BODY_CHARS)),
  anchors: Schema.Array(CommentAnchorSchema).pipe(Schema.minItems(1), Schema.maxItems(MAX_COMMENT_ANCHORS)),
  resolved: Schema.Boolean,
  resolvedBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export { CommentAnchorSchema, CommentRecordSchema };

/** One anchor candidate as stored and sent over the wire. */
export type CommentAnchor = typeof CommentAnchorSchema.Type;
/** One stored comment. */
export type CommentRecord = typeof CommentRecordSchema.Type;

/** Builds the DB key of one comment. */
export function commentKey(project: string, page: string, id: string): string {
  return `${pageCommentsPrefix(project, page)}${id}`;
}

/** Builds the key prefix that lists every comment on one page. */
export function pageCommentsPrefix(project: string, page: string): string {
  return `${project}/${encodeKeySegment(page)}/`;
}

/** Builds the key prefix that lists every comment of one project. */
export function projectCommentsPrefix(project: string): string {
  return `${project}/`;
}

/**
 * Normalizes a viewer-supplied page path into the canonical comment page key:
 * percent-decoded, single slashes, no trailing "index.html", no trailing slash
 * (except the root "/"). Returns null for anything unsafe. The widget applies
 * the same normalization client-side so pins land on the page they were left on
 * regardless of how the URL was spelled.
 */
export function normalizeCommentPage(value: string): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_COMMENT_PAGE_CHARS) return null;
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("?") || decoded.includes("#")) return null;
  let normalized = decoded.replace(/\/+/g, "/");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (normalized.endsWith("/index.html")) normalized = normalized.slice(0, -"index.html".length);
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "") normalized = "/";
  return normalized.length > MAX_COMMENT_PAGE_CHARS ? null : normalized;
}

/** Returns true when a string is already a normalized comment page path. */
export function isSafeCommentPage(value: string): boolean {
  return normalizeCommentPage(value) === value;
}

/** Percent-encodes a page path into one key segment, additionally escaping "."
 * (which encodeURIComponent leaves bare) so a page can never form a "." or
 * ".." key segment. Mirrors the owner-index encoding in site-records.ts. */
function encodeKeySegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}
