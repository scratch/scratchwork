/*
 * `scratchwork dev` - serve a project directory locally with hot reload.
 * Wires together the dev server, the live-reload watcher, and the heartbeat
 * that keeps browser SSE connections alive.
 */
import type { PlatformError } from "@effect/platform/Error";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as PubSub from "effect/PubSub";
import { openBrowser } from "../browser";
import { heartbeat, startReloadWatcher } from "../dev/live-reload";
import { logDebug } from "../dev/output";
import { serve } from "../dev/server";
import { resolveDevTarget } from "../dev/target";
import type { DevServices, DevState } from "../dev/types";
import { CliError } from "../errors";
import type { DevConfig } from "../types";

export const DEFAULT_PORT = 3000;

/** Runs `scratchwork dev`: serve the target, watch files, and keep the process alive. */
export function runDev(
  config: DevConfig,
): Effect.Effect<void, PlatformError | CliError, DevServices> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* logDebug("dev command starting", {
        path: config.path,
        start_port: config.port,
      });

      yield* validatePort(config.port);

      const target = yield* resolveDevTarget(config.path);
      yield* Effect.annotateLogsScoped({
        root: target.root,
        open_path: target.openPath,
      });
      yield* logDebug("dev target resolved");

      const reloads = yield* Effect.acquireRelease(
        PubSub.sliding<Uint8Array>(64),
        PubSub.shutdown,
      );
      const state: DevState = {
        ...target,
        reloads,
        loggedMarkdownRoutes: new Set(),
      };

      const { port } = yield* serve(state, config.port);
      const url = `http://localhost:${port}${state.openPath}`;
      yield* logDebug("dev server started", { port, url });

      yield* heartbeat(state).pipe(Effect.forkScoped);
      const watcher = yield* startReloadWatcher(state).pipe(Effect.forkScoped);
      yield* printBanner(state, url);
      yield* openBrowser(url);
      // Joining the watcher fiber makes its failure surface as a CliError
      // instead of dying silently; zipRight keeps serving if it ever completes.
      return yield* Fiber.join(watcher).pipe(Effect.zipRight(Effect.never));
    }),
  ).pipe(Effect.annotateLogs("command", "dev"));

  return config.verbose
    ? program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug))
    : program;
}

/** Validates the user-supplied starting port before attempting to bind. */
function validatePort(port: number): Effect.Effect<void, CliError> {
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? Effect.void
    : Effect.fail(
        new CliError({
          code: 1,
          message: `scratchwork dev: invalid --port "${port}"`,
        }),
      );
}

/** Prints the stable startup banner consumed by users and e2e tests. */
function printBanner(
  state: DevState,
  url: string,
): Effect.Effect<void> {
  return Console.log(
    [
      "\n  scratchwork dev",
      `  serving  ${state.root}`,
      `  at       ${url}`,
      "  watching .md .html .js .css - hot reload on\n",
    ].join("\n"),
  );
}
