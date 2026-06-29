import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { defaultServerUrl, decodeLoginCallback, loginUrl, normalizeServerUrl, writeAuthToken } from "../auth";
import { openBrowser } from "../browser";
import { CliError, errorMessage } from "../errors";
import type { LoginConfig } from "../types";

interface LoginResult {
  readonly token: string;
  readonly email?: string;
  readonly server?: string;
}

interface LoginServer {
  readonly callbackUrl: string;
  readonly result: Promise<LoginResult>;
  readonly stop: () => void;
}

export function runLogin(
  config: LoginConfig,
): Effect.Effect<void, PlatformError | CliError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const server = defaultServerUrl(config.server);
    const callback = yield* startLoginServer();
    const url = loginUrl(server, callback.callbackUrl);

    yield* Console.log(`Opening browser to authenticate with ${server}`);
    yield* Console.log(`If it does not open, visit:\n${url}`);
    yield* openBrowser(url);

    const result = yield* Effect.tryPromise({
      try: () => callback.result,
      catch: (cause) => new CliError({ code: 1, message: `scratchwork login: ${errorMessage(cause)}` }),
    }).pipe(Effect.ensuring(Effect.sync(callback.stop)));

    const authenticatedServer = normalizeServerUrl(result.server ?? server);
    yield* writeAuthToken(authenticatedServer, result.token, result.email);
    yield* Console.log(`Authenticated ${result.email ?? "user"} for ${authenticatedServer}`);
  });
}

function startLoginServer(): Effect.Effect<LoginServer, CliError> {
  return Effect.sync(() => {
    let settled = false;
    let resolveResult: (result: LoginResult) => void;
    let rejectResult: (error: Error) => void;
    const result = new Promise<LoginResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.pathname !== "/callback") {
            return new Response("Not found", { status: 404 });
          }
          const decoded = decodeLoginCallback(url);
          if (!settled) {
            settled = true;
            setTimeout(() => resolveResult(decoded), 250);
          }
          return new Response("Scratchwork login complete. You can close this tab.\n", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            setTimeout(() => rejectResult(error instanceof Error ? error : new Error(String(error))), 250);
          }
          return new Response("Scratchwork login failed. Return to the terminal.\n", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      },
    });

    return {
      callbackUrl: `http://127.0.0.1:${server.port}/callback`,
      result,
      stop: () => server.stop(false),
    };
  }).pipe(
    Effect.mapError((cause) =>
      new CliError({ code: 1, message: `scratchwork login: ${errorMessage(cause)}` }),
    ),
  );
}
