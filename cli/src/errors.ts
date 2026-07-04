/*
 * The CLI's error type. Command handlers fail with CliError; the entrypoint in
 * index.ts prints its message (when present) and exits with its code.
 */
import * as Data from "effect/Data";

export { errorMessage } from "../../shared/src/util/errors";

/** A user-facing CLI failure: `message` is printed to stderr, `code` becomes the exit code. */
export class CliError extends Data.TaggedError("CliError")<{
  readonly code: number;
  readonly message?: string;
}> {}
