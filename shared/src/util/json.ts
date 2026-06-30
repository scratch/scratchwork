/** Parses JSON and returns null instead of throwing on invalid input. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Checks whether an unknown value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts arbitrary thrown values into readable error messages. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { readonly message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}
