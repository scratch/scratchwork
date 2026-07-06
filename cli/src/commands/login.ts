/*
 * `scratchwork login` - authenticate this machine with a Scratchwork server.
 *
 * Starts a one-shot loopback HTTP server, opens the browser to the server's
 * login page with a redirect back to that loopback callback, and stores the
 * bearer token the callback delivers.
 */
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { decodeLoginCallback, loginUrl, normalizeServerUrl, writeAuthToken, type LoginCallback } from "../auth";
import { openBrowser } from "../browser";
import { CliError, errorMessage } from "../errors";
import { resolveServerFromCwd } from "../project-config";
import type { LoginConfig } from "../types";

/** Runs `scratchwork login`: browser round trip, then persist the returned token. */
export function runLogin(
  config: LoginConfig,
): Effect.Effect<void, PlatformError | CliError, CommandExecutor | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const server = yield* resolveServerFromCwd(config.server, "login");
    const result = yield* awaitBrowserLogin(server);
    // The callback's server parameter is server-controlled input; a malformed
    // URL must fail as a CliError, not crash the fiber.
    const authenticatedServer = yield* Effect.try({
      try: () => normalizeServerUrl(result.server ?? server),
      catch: () => new CliError({ code: 1, message: `scratchwork login: server returned an invalid server URL: ${result.server}` }),
    });
    yield* writeAuthToken(authenticatedServer, result.token, result.email);
    yield* Console.log(`Authenticated ${result.email ?? "user"} for ${authenticatedServer}`);
  });
}

/**
 * Serves the loopback callback until the browser delivers a login token.
 * The server binds 127.0.0.1 only, ignores stray or invalid requests instead
 * of failing the login, and is released with the surrounding scope.
 */
function awaitBrowserLogin(
  server: string,
): Effect.Effect<LoginCallback, CliError, CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const done = yield* Deferred.make<LoginCallback>();
      const callback = yield* Effect.acquireRelease(
        Effect.try({
          try: () => serveLoginCallback(done),
          catch: (cause) => new CliError({ code: 1, message: `scratchwork login: ${errorMessage(cause)}` }),
        }),
        (bunServer) => Effect.sync(() => bunServer.stop(false)),
      );
      const url = loginUrl(server, `http://127.0.0.1:${callback.port}/callback`);

      yield* Console.log(`Opening browser to authenticate with ${server}`);
      yield* Console.log(`If it does not open, visit:\n${url}`);
      yield* openBrowser(url);

      const result = yield* Deferred.await(done);
      // Give the browser a beat to receive the confirmation page before the
      // scope closes and stops the server.
      yield* Effect.sleep("250 millis");
      return result;
    }),
  );
}

/** Starts the Bun loopback server that completes `done` on the first valid callback. */
function serveLoginCallback(done: Deferred.Deferred<LoginCallback>) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      const decoded = decodeLoginCallback(url);
      if (decoded == null) {
        return new Response("Scratchwork login failed. Return to the terminal.\n", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      Deferred.unsafeDone(done, Effect.succeed(decoded));
      return new Response("Scratchwork login complete. You can close this tab.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });
}
