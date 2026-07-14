/*
 * `scratchwork login` - authenticate this machine with a Scratchwork server.
 *
 * Starts a one-shot loopback HTTP server, opens the browser to the server's
 * login page with a redirect back to that loopback callback, and completes an
 * RFC 8252-style handoff: the callback delivers only a short-lived one-time
 * authorization code (bound to this process's state and PKCE challenge), which
 * the CLI exchanges over a back-channel POST for the bearer token it stores.
 */
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import type * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CLI_TOKEN_EXCHANGE_PATH,
  CliTokenResponseSchema,
  type CliTokenRequest,
  type CliTokenResponse,
} from "../../../shared/src/publish/api";
import { apiJson } from "../api";
import {
  generateLoginProof,
  loginUrl,
  normalizeServerUrl,
  serverApiUrl,
  writeAuthToken,
  type LoginCallback,
} from "../auth";
import { openBrowser } from "../browser";
import { CliError, errorMessage } from "../errors";
import { resolveServerFromCwd } from "../project-config";
import type { LoginConfig } from "../types";
import { serveLoginCallback } from "./login-callback-server";

/** Everything runLogin and its callers need from the platform. */
type LoginServices = CommandExecutor | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient;

/** Runs `scratchwork login`: browser round trip, code exchange, then persist the token. */
export function runLogin(
  config: LoginConfig,
): Effect.Effect<void, PlatformError | CliError, LoginServices> {
  return Effect.gen(function* () {
    const server = yield* resolveServerFromCwd(config.server, "login");
    const result = yield* awaitBrowserLogin(server);
    // The exchange's server field is server-controlled input; a malformed URL
    // must fail as a CliError, not crash the fiber.
    const authenticatedServer = yield* Effect.try({
      try: () => normalizeServerUrl(result.server),
      catch: () => new CliError({ code: 1, message: `scratchwork login: server returned an invalid server URL: ${result.server}` }),
    });
    yield* writeAuthToken(authenticatedServer, result.token, result.email, result.cfToken);
    yield* Console.log(`Authenticated ${result.email} for ${authenticatedServer}`);
  });
}

/**
 * Serves the loopback callback until the browser delivers this login's
 * authorization code, then redeems it over the back-channel exchange. The
 * server binds 127.0.0.1 only on an ephemeral port, accepts only the exact
 * /callback path carrying this transaction's state (stray or competing
 * requests get an error and the listener keeps waiting), and is released with
 * the surrounding scope after the first completed exchange.
 */
function awaitBrowserLogin(
  server: string,
): Effect.Effect<CliTokenResponse, CliError, LoginServices> {
  return Effect.scoped(
    Effect.gen(function* () {
      const proof = yield* generateLoginProof();
      const done = yield* Deferred.make<LoginCallback>();
      const callback = yield* Effect.acquireRelease(
        Effect.try({
          try: () => serveLoginCallback(done, proof.state),
          catch: (cause) => new CliError({ code: 1, message: `scratchwork login: ${errorMessage(cause)}` }),
        }),
        (server) => Effect.sync(() => {
          // Interruption/timeout must release the browser's pending callback too.
          server.settleExchange(false);
          server.stop();
        }),
      );
      const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
      const url = loginUrl(server, redirectUri, proof);

      yield* Console.log(`Opening browser to authenticate with ${server}`);
      yield* Console.log(`If it does not open, visit:\n${url}`);
      yield* openBrowser(url);

      const outcome = yield* Deferred.await(done);
      if ("error" in outcome) {
        callback.settleExchange(false);
        return yield* Effect.fail(
          new CliError({ code: 1, message: `scratchwork login: the server reported a failed login (${outcome.error})` }),
        );
      }
      const result = yield* exchangeLoginCode(server, outcome.code, proof.codeVerifier, redirectUri).pipe(
        Effect.tapError(() => Effect.sync(() => callback.settleExchange(false))),
      );
      callback.settleExchange(true);
      // Give the browser a beat to receive the confirmation page before the
      // scope closes and stops the server.
      yield* Effect.sleep("250 millis");
      return result;
    }),
  ).pipe(
    Effect.timeoutFail({
      duration: "2 minutes",
      onTimeout: () => new CliError({ code: 1, message: "scratchwork login: timed out waiting for browser authentication" }),
    }),
  );
}

/** Redeems the one-time authorization code, proving possession of the PKCE
 * verifier from the exact redirect URI the code was delivered to. */
function exchangeLoginCode(
  server: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Effect.Effect<CliTokenResponse, CliError, HttpClient.HttpClient | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const body: CliTokenRequest = { code, codeVerifier, redirectUri };
    const json = yield* apiJson("scratchwork login", serverApiUrl(server, CLI_TOKEN_EXCHANGE_PATH), {
      method: "POST",
      body,
    });
    // Tolerant decoding on purpose: unknown fields from a newer server are ignored.
    const decoded = Schema.decodeUnknownOption(CliTokenResponseSchema)(json);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(new CliError({ code: 1, message: "scratchwork login: invalid server response" }));
    }
    return decoded.value;
  });
}

