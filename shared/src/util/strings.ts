/*
 * String normalization helpers shared by CLI and server configuration code.
 */

/** Collapses empty strings to undefined so config values can use `??` chains. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}
