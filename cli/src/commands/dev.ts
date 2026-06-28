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
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  collectComponentNames,
  componentFileCandidates,
} from "../../../shared/src/site/components";
import { SiteFiles } from "../../../shared/src/site/files";
import type { HtmlTransform } from "../../../shared/src/site/html";
import type { SitePath } from "../../../shared/src/site/paths";
import {
  serveRequest,
  type RendererSource,
  type SiteServeEvent,
} from "../../../shared/src/site/serve";
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
  // Markdown diagnostics are useful once. Browser reloads should not reprint the
  // same render/component summary after every component or CSS save.
  readonly loggedMarkdownRoutes: Set<string>;
}

function logDebug(
  message: string,
  annotations: Record<string, unknown> = {},
): Effect.Effect<void> {
  return Effect.logDebug(message).pipe(Effect.annotateLogs(annotations));
}

function status(label: string, message: string): Effect.Effect<void> {
  return Console.log(`  ${label.padEnd(10)} ${message}`);
}

function problem(message: string): Effect.Effect<void> {
  return Console.log(`  ! ${message}`);
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

function injectReloadScript(html: string): string {
  const tag = `\n<script data-scratchwork-dev>${CLIENT}</script>\n`;
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

const injectReloadClient: HtmlTransform = (html) =>
  Effect.succeed(injectReloadScript(html));

function rendererLabel(renderer: RendererSource): string {
  switch (renderer._tag) {
    case "Project":
      return renderer.path;
    case "Fallback":
      return "embedded renderer";
    case "None":
      return "no renderer";
  }
}

function rendererHasInlineComponent(
  rendererHtml: string | undefined,
  name: string,
): boolean {
  if (rendererHtml == null) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `SCRATCHWORK\\.components(?:\\.${escaped}|\\[['"]${escaped}['"]\\])\\b`,
  ).test(rendererHtml);
}

type ComponentResolution =
  | {
      readonly name: string;
      readonly source: "renderer";
    }
  | {
      readonly name: string;
      readonly source: "file";
      readonly path: SitePath;
    }
  | {
      readonly name: string;
      readonly source: "missing";
      readonly candidates: ReadonlyArray<SitePath>;
    };

function resolveComponent(
  markdownPath: SitePath,
  rendererHtml: string | undefined,
  name: string,
): Effect.Effect<ComponentResolution, never, SiteFiles> {
  return Effect.gen(function* () {
    if (rendererHasInlineComponent(rendererHtml, name)) {
      return { name, source: "renderer" } as const;
    }

    const files = yield* SiteFiles;
    const candidates = componentFileCandidates(markdownPath, name);
    for (const candidate of candidates) {
      if (yield* files.exists(candidate)) {
        return { name, source: "file", path: candidate } as const;
      }
    }

    return { name, source: "missing", candidates } as const;
  }).pipe(
    Effect.catchAll((_error) =>
      Effect.succeed({
        name,
        source: "missing",
        candidates: componentFileCandidates(markdownPath, name),
      } as const),
    ),
  );
}

function formatComponentResolution(component: ComponentResolution): string {
  switch (component.source) {
    case "renderer":
      return `${component.name} -> renderer`;
    case "file":
      return `${component.name} -> ${component.path}`;
    case "missing":
      return `${component.name} missing`;
  }
}

function logMarkdownComponents(
  markdownPath: SitePath,
  rendererHtml?: string,
): Effect.Effect<void, never, SiteFiles> {
  return Effect.gen(function* () {
    const files = yield* SiteFiles;
    const markdown = yield* files.readText(markdownPath);
    const names = collectComponentNames(markdown);
    if (names.length === 0) {
      yield* status("components", `${markdownPath}: none`);
      return;
    }

    const components = yield* Effect.forEach(names, (name) =>
      resolveComponent(markdownPath, rendererHtml, name),
    );
    yield* status(
      "components",
      `${markdownPath}: ${components.map(formatComponentResolution).join("; ")}`,
    );
    yield* Effect.forEach(
      components,
      (component) =>
        component.source === "missing"
          ? problem(
              `missing React component ${component.name} in ${markdownPath} (tried ${component.candidates.join(", ")})`,
            )
          : Effect.void,
      { discard: true },
    );
  }).pipe(
    Effect.catchAll((error) =>
      problem(
        `could not scan React components in ${markdownPath}: ${errorMessage(error)}`,
      ),
    ),
  );
}

function logServeEvent(
  state: DevState,
  event: SiteServeEvent,
): Effect.Effect<void, never, SiteFiles> {
  switch (event._tag) {
    case "StaticHtmlServed":
      return status("html", event.path);

    case "RawMarkdownServed":
      return Effect.void;

    case "RenderedMarkdownServed": {
      const key = `${event.markdownPath}\0${rendererLabel(event.renderer)}`;
      if (state.loggedMarkdownRoutes.has(key)) return Effect.void;
      state.loggedMarkdownRoutes.add(key);

      const rendererLog =
        event.renderer._tag === "None"
          ? problem(`no renderer available for ${event.markdownPath}`)
          : status(
              "render",
              `${event.markdownPath} via ${rendererLabel(event.renderer)}`,
            );

      return rendererLog.pipe(
        Effect.zipRight(
          logMarkdownComponents(
            event.markdownPath as SitePath,
            event.rendererHtml,
          ),
        ),
      );
    }
  }
}

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
      const route = paths.basename(target).replace(/\.(html?|md)$/i, "");
      return {
        root: paths.dirname(target),
        openPath: route.toLowerCase() === "index" ? "/" : `/${route}`,
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

function heartbeat(state: DevState): Effect.Effect<never> {
  return Effect.forever(
    Effect.sleep("20 seconds").pipe(Effect.zipRight(publish(state, HEARTBEAT))),
  );
}

function reloadPayload(
  pathname: string,
): Effect.Effect<Option.Option<ReloadPayload>, never, Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    if (
      !pathname ||
      pathname.includes("node_modules") ||
      pathname.startsWith(".git") ||
      pathname.includes(paths.sep + ".git")
    ) {
      return Option.none();
    }
    const ext = paths.extname(pathname).toLowerCase();
    if (!WATCH_EXT.has(ext)) return Option.none();
    return Option.some({ path: pathname, ext: ext.slice(1) });
  });
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
    Stream.filterMap((payload) => payload),
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
): Effect.Effect<
  void,
  never,
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
> {
  const how = payload.ext === "md" ? "refresh" : "reload";
  return status("changed", `${payload.path} -> ${how}`).pipe(
    Effect.zipRight(notify(state, payload)),
  );
}

function startReloadWatcher(
  state: DevState,
): Effect.Effect<
  void,
  CliError,
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
> {
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
  const program = Effect.scoped(
    Effect.gen(function* () {
      const startPort = config.port ?? DEFAULT_PORT;
      const pathArg = config.path ?? ".";
      yield* logDebug("dev command starting", {
        path: pathArg,
        start_port: startPort,
      });

      if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
        return yield* Effect.fail(
          new CliError({
            code: 1,
            message: `scratchwork dev: invalid --port "${startPort}"`,
          }),
        );
      }

      const target = yield* resolveDevTarget(pathArg);
      yield* Effect.annotateLogsScoped({
        root: target.root,
        open_path: target.openPath,
      });
      yield* logDebug("dev target resolved");
      const reloads = yield* PubSub.sliding<Uint8Array>(64);
      yield* Effect.addFinalizer(() => PubSub.shutdown(reloads));
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
  ).pipe(Effect.annotateLogs("command", "dev"));

  return config.verbose
    ? program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug))
    : program;
}
