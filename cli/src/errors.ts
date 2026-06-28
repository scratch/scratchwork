import * as Data from "effect/Data";

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: number;
  readonly message?: string;
}> {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}
