/*
 * The `scratchwork dev` HTTP server: binds the first free port at or above the
 * requested one, then serves site routes through the shared serving pipeline
 * with live reload injected into HTML responses.
 *
 * "Free" is judged from the browser's point of view. The banner URL says
 * `localhost`, which resolves to 127.0.0.1 and ::1, so a port only counts as
 * free when both of those addresses can be bound. Bun's own wildcard bind is
 * not enough evidence: on macOS (BSD socket semantics) a wildcard listener
 * happily coexists with another process's 127.0.0.1:PORT listener, so the dev
 * server would start without error while http://localhost:PORT kept serving
 * the other process. Each candidate port is therefore probed on the loopback
 * addresses before the real server binds it. The probe is best-effort: it is
 * released before the real bind, so a process grabbing the specific address in
 * that gap still wins, but that window is microseconds wide.
 */
import type * as HttpApp from "@effect/platform/HttpApp";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Effect from "effect/Effect";
import { serveRequest } from "@scratchwork/shared/site/serve";
import { FIGURE_SVG } from "@scratchwork/shared/assets/figure-svg.generated";
import { CliError, errorMessage } from "../errors";
import { loadShell } from "../renderer/default";
import * as SiteFilesLive from "./site-files";
import { logServeEvent } from "./diagnostics";
import { injectReloadClient, RELOAD_PATH, sseResponse } from "./live-reload";
import { logDebug } from "./output";
import type { DevServices, DevState, ScopedDevServices } from "./types";

const NO_STORE = "no-store, must-revalidate";

/** Every address `localhost` may resolve to; all must be bindable for a port to be free. */
const LOOPBACK_ADDRESSES: ReadonlyArray<string> = ["127.0.0.1", "::1"];

/** Starts the dev HTTP server, probing upward when the requested port is busy. */
export function serve(
  state: DevState,
  startPort: number,
): Effect.Effect<{ readonly port: number }, CliError, ScopedDevServices> {
  return Effect.gen(function* () {
    let port = startPort;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(yield* loopbackFree(port))) {
        port++;
        continue;
      }
      const result = yield* BunHttpServer.make({ port, idleTimeout: 0 }).pipe(
        Effect.flatMap((server) =>
          server.serve(devApp(state)).pipe(Effect.as({ port })),
        ),
        Effect.catchAllDefect((error) =>
          addressInUse(error)
            ? logDebug("dev port in use", { port }).pipe(Effect.as(null))
            : logDebug("dev server startup defect", {
                port,
                error: errorMessage(error),
              }).pipe(
                Effect.zipRight(
                  Effect.fail(
                    new CliError({
                      code: 1,
                      message: `scratchwork dev: ${errorMessage(error)}`,
                    }),
                  ),
                ),
              ),
        ),
      );
      if (result != null) return result;
      port++;
    }
    return yield* Effect.fail(
      new CliError({
        code: 1,
        message: `scratchwork dev: no free port found in [${startPort}, ${startPort + 100})`,
      }),
    );
  });
}

/** Builds the Effect HTTP app used by the Bun server. */
function devApp(state: DevState): HttpApp.Default<never, DevServices> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* handleRequest(state, request).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          HttpServerResponse.text(errorMessage(error), {
            status: 500,
            contentType: "text/plain; charset=utf-8",
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(SiteFilesLive.layer(state.root)));
}

/** Routes the reload endpoint separately, then delegates site routes to shared serving. */
function handleRequest(
  state: DevState,
  request: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === RELOAD_PATH) return sseResponse(state);

    return yield* serveRequest(request, {
      cacheControl: () => NO_STORE,
      defaultFaviconSvg: FIGURE_SVG,
      htmlTransforms: [injectReloadClient],
      onServeEvent: (event) => logServeEvent(state, event),
      rendererFallback: loadShell(),
    });
  });
}

/**
 * True when a throwaway TCP listener can be opened on every loopback address at
 * `port`. Only an address-in-use failure marks the port as taken; anything else
 * (for example ::1 on a host without IPv6) is not evidence of a competing
 * server, so the real bind decides. Short-circuits on the first taken address.
 */
function loopbackFree(port: number): Effect.Effect<boolean> {
  return Effect.every(LOOPBACK_ADDRESSES, (hostname) =>
    probeBind(hostname, port),
  );
}

/** Binds and immediately releases `hostname:port`; false only on address-in-use. */
function probeBind(hostname: string, port: number): Effect.Effect<boolean> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.listen({ hostname, port, socket: { data() {} } }),
      catch: (error) => error,
    }),
    () => Effect.succeed(true),
    (listener) => Effect.sync(() => listener.stop(true)),
  ).pipe(
    Effect.catchAll((error) =>
      addressInUse(error)
        ? logDebug("dev port in use on loopback", { hostname, port }).pipe(
            Effect.as(false),
          )
        : logDebug("dev port probe inconclusive", {
            hostname,
            port,
            error: errorMessage(error),
          }).pipe(Effect.as(true)),
    ),
  );
}

/** Detects Bun's address-in-use failures: defects from Bun.serve, typed failures from the probe. */
function addressInUse(error: unknown): boolean {
  const candidate = error as {
    readonly code?: string;
    readonly message?: string;
  };
  return (
    candidate.code === "EADDRINUSE" ||
    /in use|address already/i.test(errorMessage(error))
  );
}
