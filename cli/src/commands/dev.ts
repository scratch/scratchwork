import type { PlatformError } from "@effect/platform/Error";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
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
      const startPort = config.port ?? DEFAULT_PORT;
      const pathArg = config.path ?? ".";
      yield* logDebug("dev command starting", {
        path: pathArg,
        start_port: startPort,
      });

      yield* validatePort(startPort);

      const target = yield* resolveDevTarget(pathArg);
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

      const { port } = yield* serve(state, startPort);
      const url = `http://localhost:${port}${state.openPath}`;
      yield* logDebug("dev server started", { port, url });

      yield* heartbeat(state).pipe(Effect.forkScoped);
      yield* startReloadWatcher(state).pipe(Effect.forkScoped);

      yield* printBanner(state, url);
      yield* Effect.sync(() => openBrowser(url));
      return yield* Effect.never;
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
