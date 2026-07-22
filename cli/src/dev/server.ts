/*
 * The `scratchwork dev` HTTP server: binds the first free port at or above the
 * requested one, then serves site routes through the shared serving pipeline
 * with live reload injected into HTML responses.
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

/** Starts the dev HTTP server, probing upward when the requested port is busy. */
export function serve(
  state: DevState,
  startPort: number,
): Effect.Effect<{ readonly port: number }, CliError, ScopedDevServices> {
  return Effect.gen(function* () {
    let port = startPort;
    for (let attempt = 0; attempt < 100; attempt++) {
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

/** Detects Bun's address-in-use failures, which arrive as defects here. */
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
