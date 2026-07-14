/*
 * The one-shot loopback HTTP server behind `scratchwork login`.
 *
 * This module is a deliberate Promise boundary under invariant 1: Bun.serve's
 * fetch handler is inherently async, and the browser's callback response is
 * held on a Promise until the back-channel exchange settles so the page
 * reports what actually happened rather than assuming success. Everything
 * else about the login flow stays Effect-only in login.ts.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { decodeLoginCallback, type LoginCallback } from "../auth";

/** A running loopback callback server plus its coordination handles. */
export interface LoginCallbackServer {
  /** The ephemeral 127.0.0.1 port the server bound. */
  readonly port: number;
  /** Resolves the browser's held callback response with the exchange outcome. */
  readonly settleExchange: (ok: boolean) => void;
  /** Stops accepting new connections; in-flight requests (including the held
   * callback response) are allowed to finish, so call settleExchange first to
   * unblock them. */
  readonly stop: () => void;
}

/** Starts the Bun loopback server that completes `done` on the first callback
 * carrying this login's state, answering with the exchange's real outcome.
 * The server binds 127.0.0.1 only, on an ephemeral port, and accepts only the
 * exact /callback path; stray or competing requests get an error and the
 * listener keeps waiting. */
export function serveLoginCallback(
  done: Deferred.Deferred<LoginCallback>,
  expectedState: string,
): LoginCallbackServer {
  let settleExchange: (ok: boolean) => void = () => {};
  const exchangeSettled = new Promise<boolean>((resolve) => {
    settleExchange = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      const decoded = decodeLoginCallback(url, expectedState);
      if (decoded == null) {
        return new Response("Scratchwork login failed. Return to the terminal.\n", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      Deferred.unsafeDone(done, Effect.succeed(decoded));
      const ok = "code" in decoded && (await exchangeSettled);
      return ok
        ? new Response("Scratchwork login complete. You can close this tab.\n", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        : new Response("Scratchwork login failed. Return to the terminal.\n", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
    },
  });
  const port = server.port;
  if (port == null) {
    server.stop(true);
    throw new Error("loopback callback server did not bind a port");
  }
  return {
    port,
    settleExchange,
    stop: () => server.stop(false),
  };
}
