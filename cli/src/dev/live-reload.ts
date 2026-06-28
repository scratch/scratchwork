import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { HtmlTransform } from "../../../shared/src/site/html";
import { errorMessage, CliError } from "../errors";
import type { ReloadPayload } from "../types";
import { status } from "./output";
import type { DevState } from "./types";

export const RELOAD_PATH = "/__scratchwork_reload";

const WATCH_EXT = new Set([".md", ".html", ".js", ".css"]);
const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(": ping\n\n");

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

/** Creates the long-lived SSE response consumed by the browser reload client. */
export function sseResponse(
  state: DevState,
): HttpServerResponse.HttpServerResponse {
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

/** Injects the browser reload client into served HTML responses. */
export const injectReloadClient: HtmlTransform = (html) =>
  Effect.succeed(injectReloadScript(html));

/** Publishes a periodic SSE comment so proxies keep the reload stream open. */
export function heartbeat(state: DevState): Effect.Effect<never> {
  return Effect.forever(
    Effect.sleep("20 seconds").pipe(Effect.zipRight(publish(state, HEARTBEAT))),
  );
}

/** Starts the filesystem watcher and sends reload messages for relevant files. */
export function startReloadWatcher(
  state: DevState,
): Effect.Effect<void, CliError, FileSystem.FileSystem | Path.Path> {
  return watchReloads(state).pipe(
    Stream.runForEach((payload) => logReload(state, payload)),
  );
}

/** Inserts the reload client before `</body>`, falling back to appending it. */
function injectReloadScript(html: string): string {
  const tag = `\n<script data-scratchwork-dev>${CLIENT}</script>\n`;
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

/** Publishes raw SSE bytes to every connected browser stream. */
function publish(state: DevState, payload: Uint8Array): Effect.Effect<void> {
  return state.reloads.publish(payload).pipe(Effect.asVoid);
}

/** Sends one JSON reload event to connected browsers. */
function notify(state: DevState, data: ReloadPayload): Effect.Effect<void> {
  return publish(
    state,
    encoder.encode("data: " + JSON.stringify(data) + "\n\n"),
  );
}

/** Converts a filesystem watch path into a reload payload, or ignores it. */
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

/** Watches the site root and emits debounced reload payloads for known file types. */
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

/** Prints a compact change line and notifies connected browsers. */
function logReload(
  state: DevState,
  payload: ReloadPayload,
): Effect.Effect<void> {
  const how = payload.ext === "md" ? "refresh" : "reload";
  return status("changed", `${payload.path} -> ${how}`).pipe(
    Effect.zipRight(notify(state, payload)),
  );
}
