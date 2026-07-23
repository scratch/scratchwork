/**
 * Storage operations for viewer comments, as plain functions over PrimitiveDb
 * (no service tag: every caller — the comments routes and the site store's
 * delete purge — already holds the PrimitiveDb service). Pure storage only;
 * who may create, edit, resolve, or delete a comment is decided by the
 * comments routes, which hold the viewer's project role. See
 * comment-records.ts for the persisted data model.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import {
  COMMENTS_NAMESPACE,
  commentKey,
  CommentRecordSchema,
  pageCommentsPrefix,
  projectCommentsPrefix,
  type CommentRecord,
} from "./comment-records.ts";
import {
  PrimitiveDbConflict,
  type JsonValue,
  type PrimitiveDbError,
  type PrimitiveDbRecord,
  type PrimitiveDbShape,
} from "./db.ts";

/** How large a comment key may grow; PrimitiveDb rejects longer keys with a 500,
 * so the store fails 400 first. */
const MAX_COMMENT_KEY_CHARS = 1024;

/** Comment-store failure; `status` becomes the HTTP response status. */
export class CommentStoreError extends Data.TaggedError("CommentStoreError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A decoded comment plus the version metadata needed for conditional writes. */
export interface LoadedComment {
  readonly value: CommentRecord;
  readonly version: number;
}

/** Lists every comment on one page, oldest first (comment ids are
 * creation-time prefixed, and listing is UTF-8 key order). */
export function listPageComments(
  db: PrimitiveDbShape,
  project: string,
  page: string,
): Effect.Effect<ReadonlyArray<CommentRecord>, CommentStoreError> {
  return listCommentRecords(db, pageCommentsPrefix(project, page)).pipe(
    Effect.flatMap((records) => Effect.forEach(records, (record) => decodeComment(record))),
    Effect.map((loaded) => loaded.map((comment) => comment.value)),
  );
}

/** Writes a new comment; the create-only precondition makes id collisions
 * (vanishingly unlikely) an explicit conflict instead of an overwrite. */
export function createComment(
  db: PrimitiveDbShape,
  record: CommentRecord,
): Effect.Effect<CommentRecord, CommentStoreError> {
  return Effect.gen(function* () {
    const key = commentKey(record.project, record.page, record.id);
    if (key.length > MAX_COMMENT_KEY_CHARS) {
      return yield* Effect.fail(new CommentStoreError({ status: 400, message: "Page path is too long for comments" }));
    }
    const written = yield* db.put(COMMENTS_NAMESPACE, key, record, { ifNoneMatch: "*" }).pipe(
      Effect.mapError(dbError),
      Effect.flatMap(decodeComment),
    );
    return written.value;
  });
}

/** Loads one comment with its write-precondition version, or null when absent. */
export function loadComment(
  db: PrimitiveDbShape,
  project: string,
  page: string,
  id: string,
): Effect.Effect<LoadedComment | null, CommentStoreError> {
  return db.get<JsonValue>(COMMENTS_NAMESPACE, commentKey(project, page, id)).pipe(
    Effect.mapError(dbError),
    Effect.flatMap((record) => record == null ? Effect.succeed(null) : decodeComment(record)),
  );
}

/** Rewrites one comment under its loaded version; a lost race is a 409. */
export function putComment(
  db: PrimitiveDbShape,
  record: CommentRecord,
  ifMatch: number,
): Effect.Effect<CommentRecord, CommentStoreError> {
  return db.put(COMMENTS_NAMESPACE, commentKey(record.project, record.page, record.id), record, { ifMatch }).pipe(
    Effect.mapError(dbError),
    Effect.flatMap(decodeComment),
    Effect.map((loaded) => loaded.value),
  );
}

/** Deletes one comment; deleting an already-gone comment is a no-op. */
export function deleteComment(
  db: PrimitiveDbShape,
  project: string,
  page: string,
  id: string,
): Effect.Effect<void, CommentStoreError> {
  return db.delete(COMMENTS_NAMESPACE, commentKey(project, page, id)).pipe(Effect.mapError(dbError));
}

/** Deletes every comment of one project. Runs before the project pointer is
 * released so a name reclaimed by a different owner can never inherit the
 * previous project's comments; a failure here fails (and thereby retries)
 * the whole project deletion. */
export function purgeProjectComments(
  db: PrimitiveDbShape,
  project: string,
): Effect.Effect<void, CommentStoreError> {
  return Effect.gen(function* () {
    const prefix = projectCommentsPrefix(project);
    while (true) {
      const page = yield* db.list<JsonValue>(COMMENTS_NAMESPACE, { prefix, limit: 1000 }).pipe(Effect.mapError(dbError));
      for (const record of page.records) {
        yield* db.delete(COMMENTS_NAMESPACE, record.key).pipe(Effect.mapError(dbError));
      }
      // Re-list from the start rather than paging: every listed key was just
      // deleted, so a cursor would skip past keys written concurrently.
      if (page.records.length === 0) return;
    }
  });
}

/** Drains every list page under a key prefix. */
function listCommentRecords(
  db: PrimitiveDbShape,
  prefix: string,
): Effect.Effect<ReadonlyArray<PrimitiveDbRecord<JsonValue>>, CommentStoreError> {
  return Effect.gen(function* () {
    const records: Array<PrimitiveDbRecord<JsonValue>> = [];
    let startAfter: string | undefined;
    do {
      const page = yield* db.list<JsonValue>(COMMENTS_NAMESPACE, { prefix, startAfter, limit: 1000 }).pipe(
        Effect.mapError(dbError),
      );
      records.push(...page.records);
      startAfter = page.cursor;
    } while (startAfter != null);
    return records;
  });
}

/** Decodes one stored comment, keeping the write-precondition version. */
function decodeComment(record: PrimitiveDbRecord<JsonValue>): Effect.Effect<LoadedComment, CommentStoreError> {
  return Schema.decodeUnknown(CommentRecordSchema)(record.value, { errors: "all" }).pipe(
    Effect.mapError((error) =>
      new CommentStoreError({
        status: 500,
        message: `Invalid stored comment ${record.namespace}/${record.key}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
      }),
    ),
    Effect.map((value) => ({ value, version: record.version })),
  );
}

/** Maps primitive-DB failures onto comment-store errors (409 for conflicts, 500 otherwise). */
function dbError(error: PrimitiveDbError | PrimitiveDbConflict): CommentStoreError {
  if (error instanceof PrimitiveDbConflict) {
    return new CommentStoreError({ status: 409, message: error.message, cause: error });
  }
  return new CommentStoreError({ status: 500, message: error.message, cause: error });
}
