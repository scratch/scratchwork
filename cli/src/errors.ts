import * as Data from "effect/Data";

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: number;
  readonly message?: string;
}> {}

export class ExitError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function exit(code = 1): never {
  throw new ExitError(code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
