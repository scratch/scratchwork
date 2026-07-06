/*
 * Small helpers for handling untrusted JSON at the edges of the system
 * (request bodies, API responses).
 */

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
