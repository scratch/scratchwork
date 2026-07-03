/*
 * Terminal output helpers for the long-running dev server: compact status
 * lines for users and structured debug logs behind --verbose.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

/** Emits a structured debug log that is visible when `scratchwork dev --verbose` is used. */
export function logDebug(
  message: string,
  annotations: Record<string, unknown> = {},
): Effect.Effect<void> {
  return Effect.logDebug(message).pipe(Effect.annotateLogs(annotations));
}

/** Prints one compact, user-facing status line for the long-running dev server. */
export function status(label: string, message: string): Effect.Effect<void> {
  return Console.log(`  ${label.padEnd(10)} ${message}`);
}

/** Prints a compact problem line without switching to Effect's verbose log formatter. */
export function problem(message: string): Effect.Effect<void> {
  return Console.log(`  ! ${message}`);
}
