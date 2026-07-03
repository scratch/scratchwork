/*
 * Best-effort opening of a URL in the user's browser. Failures are ignored;
 * setting SCRATCHWORK_NO_OPEN disables opening entirely (tests always set it).
 */
import * as Command from "@effect/platform/Command";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";

/**
 * Opens a URL with the platform's opener, ignoring any failure. The opener
 * runs in a daemon fiber: some openers (xdg-open without a desktop helper)
 * only exit when the browser does, and no command should block on that.
 */
export function openBrowser(url: string): Effect.Effect<void, never, CommandExecutor> {
  if (process.env.SCRATCHWORK_NO_OPEN) return Effect.void;
  const command =
    process.platform === "darwin"
      ? Command.make("open", url)
      : process.platform === "win32"
        ? Command.make("cmd", "/c", "start", "", url)
        : Command.make("xdg-open", url);
  return Command.exitCode(command).pipe(Effect.ignore, Effect.forkDaemon, Effect.asVoid);
}
