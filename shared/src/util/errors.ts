/*
 * Error formatting for catch blocks and failure logs, shared so every
 * surface renders thrown values the same way.
 */

/** Converts arbitrary thrown values into readable error messages. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}
