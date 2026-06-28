import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import type * as HttpApp from "@effect/platform/HttpApp";
import type * as HttpPlatform from "@effect/platform/HttpPlatform";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Path from "@effect/platform/Path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HtmlTransform } from "../../../shared/src/site/html";
import { serveRequest } from "../../../shared/src/site/serve";
import FIGURE_SVG from "../../assets/figure.svg" with { type: "text" };
import { openBrowser } from "../browser";
import { CliError, errorMessage } from "../errors";
import { bakedShell } from "../renderer/default";
import * as SiteFilesLive from "../serve/file-system-site-files";
import type { DevConfig, ReloadPayload } from "../types";

export const DEFAULT_PORT = 3000;

const RELOAD_PATH = "/__scratchwork_reload";
const WATCH_EXT = new Set([".md", ".html", ".js", ".css"]);
const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(": ping\n\n");
const NO_STORE = "no-store, must-revalidate";

interface DevState {
  // Absolute directory the dev server is allowed to serve from.
  readonly root: string;
  // URL path opened in the browser after startup, derived from the CLI path arg.
  readonly openPath: string;
  // Broadcast channel for Server-Sent Events reload messages.
  readonly reloads: PubSub.PubSub<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Live-reload client (injected into served HTML) + SSE plumbing
// ---------------------------------------------------------------------------
const CLIENT = `
(function () {
  var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
  es.onmessage = function (ev) {
    var msg = {};
    try { msg = JSON.parse(ev.data); } catch (e) {}
    var runtime = window.SCRATCHWORK;
    if (msg.ext === "md" && runtime && typeof runtime.refresh === "function") {
      try { runtime.refresh(); return; } catch (e) {}
    }
    location.reload();
  };
})();
`;

function sseResponse(state: DevState): HttpServerResponse.HttpServerResponse {
  const stream = Stream.make(encoder.encode(": connected\n\n")).pipe(
    Stream.concat(Stream.fromPubSub(state.reloads, { maxChunkSize: 1 })),
  );
  return HttpServerResponse.stream(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function publish(state: DevState, payload: Uint8Array): Effect.Effect<void> {
  return state.reloads.publish(payload).pipe(Effect.asVoid);
}

function notify(state: DevState, data: ReloadPayload): Effect.Effect<void> {
  return publish(
    state,
    encoder.encode("data: " + JSON.stringify(data) + "\n\n"),
  );
}

function injectClient(html: string): string {
  const tag = `\n<script data-scratchwork-dev>${CLIENT}</script>\n`;
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

const injectReloadClient: HtmlTransform = (html) =>
  Effect.succeed(injectClient(html));

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
      rendererFallback: bakedShell(),
    });
  });
}

function devApp(
  state: DevState,
): HttpApp.Default<
  never,
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
> {
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

function resolveDevTarget(
  pathArg: string,
): Effect.Effect<
  Pick<DevState, "root" | "openPath">,
  PlatformError | CliError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const target = paths.resolve(process.cwd(), pathArg);
    if (!(yield* fs.exists(target))) {
      return yield* Effect.fail(
        new CliError({
          code: 1,
          message: `scratchwork dev: no such file or directory: ${target}`,
        }),
      );
    }
    const info = yield* fs.stat(target);

    if (info.type === "Directory") return { root: target, openPath: "/" };
    if (info.type === "File") {
      return {
        root: paths.dirname(target),
        openPath: "/" + paths.basename(target).replace(/\.(html?|md)$/i, ""),
      };
    }
    return yield* Effect.fail(
      new CliError({
        code: 1,
        message: `scratchwork dev: no such file or directory: ${target}`,
      }),
    );
  });
}

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

function serve(
  state: DevState,
  startPort: number,
): Effect.Effect<
  { readonly port: number },
  CliError,
  | CommandExecutor.CommandExecutor
  | Scope.Scope
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
> {
  return Effect.gen(function* () {
    let port = startPort;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = yield* BunHttpServer.make({ port, idleTimeout: 0 }).pipe(
        Effect.matchEffect({
          onSuccess: (server) =>
            server.serve(devApp(state)).pipe(Effect.as({ port })),
          onFailure: () =>
            Effect.fail(
              new CliError({
                code: 1,
                message: `scratchwork dev: could not start server on port ${port}`,
              }),
            ),
        }),
        Effect.catchAllDefect((error) =>
          addressInUse(error)
            ? Effect.succeed(null)
            : Effect.fail(
                new CliError({
                  code: 1,
                  message: `scratchwork dev: ${errorMessage(error)}`,
                }),
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

function heartbeat(state: DevState): Effect.Effect<never> {
  return Effect.forever(
    Effect.sleep("20 seconds").pipe(Effect.zipRight(publish(state, HEARTBEAT))),
  );
}

function reloadPayload(
  pathname: string,
): Effect.Effect<ReloadPayload | null, never, Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    if (!pathname) return null;
    if (
      pathname.includes("node_modules") ||
      pathname.startsWith(".git") ||
      pathname.includes(paths.sep + ".git")
    ) {
      return null;
    }
    const ext = paths.extname(pathname).toLowerCase();
    if (!WATCH_EXT.has(ext)) return null;
    return { path: pathname, ext: ext.slice(1) };
  });
}

function isReloadPayload(
  payload: ReloadPayload | null,
): payload is ReloadPayload {
  return payload != null;
}

function watchReloads(
  state: DevState,
): Stream.Stream<ReloadPayload, CliError, FileSystem.FileSystem | Path.Path> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return fs.watch(state.root, { recursive: true });
    }),
  ).pipe(
    Stream.mapEffect((event) => reloadPayload(event.path)),
    Stream.filter(isReloadPayload),
    Stream.debounce("50 millis"),
    Stream.mapError(
      (error) =>
        new CliError({
          code: 1,
          message: `scratchwork dev: ${errorMessage(error)}`,
        }),
    ),
  );
}

function logReload(
  state: DevState,
  payload: ReloadPayload,
): Effect.Effect<void> {
  const how = payload.ext === "md" ? "re-render" : "reload";
  return Console.log(`  ~ ${payload.path} -> ${how}`).pipe(
    Effect.zipRight(notify(state, payload)),
  );
}

function startReloadWatcher(
  state: DevState,
): Effect.Effect<void, CliError, FileSystem.FileSystem | Path.Path> {
  return watchReloads(state).pipe(
    Stream.runForEach((payload) => logReload(state, payload)),
  );
}

export function runDev(
  config: DevConfig,
): Effect.Effect<
  void,
  PlatformError | CliError,
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const startPort = config.port ?? DEFAULT_PORT;
      const pathArg = config.path ?? ".";

      if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
        return yield* Effect.fail(
          new CliError({
            code: 1,
            message: `scratchwork dev: invalid --port "${startPort}"`,
          }),
        );
      }

      const target = yield* resolveDevTarget(pathArg);
      const reloads = yield* PubSub.sliding<Uint8Array>(64);
      yield* Effect.addFinalizer(() => PubSub.shutdown(reloads));
      const state: DevState = {
        ...target,
        reloads,
      };
      const { port } = yield* serve(state, startPort);
      const url = `http://localhost:${port}${state.openPath}`;

      yield* heartbeat(state).pipe(Effect.forkScoped);
      yield* startReloadWatcher(state).pipe(Effect.forkScoped);

      yield* Console.log(
        [
          "\n  scratchwork dev",
          `  serving  ${state.root}`,
          `  at       ${url}`,
          "  watching .md .html .js .css - hot reload on\n",
        ].join("\n"),
      );
      yield* Effect.sync(() => openBrowser(url));
      return yield* Effect.never;
    }),
  );
}
