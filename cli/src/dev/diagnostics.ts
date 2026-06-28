import * as Effect from "effect/Effect";
import {
  collectComponentNames,
  componentFileCandidates,
} from "../../../shared/src/site/components";
import { SiteFiles } from "../../../shared/src/site/files";
import type { SitePath } from "../../../shared/src/site/paths";
import type {
  RendererSource,
  SiteServeEvent,
} from "../../../shared/src/site/serve";
import { errorMessage } from "../errors";
import { problem, status } from "./output";
import type { DevState } from "./types";

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

/** Handles serving events by printing one-shot render and component summaries. */
export function logServeEvent(
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

/** Produces the short renderer label shown in compact dev output. */
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

/** Checks whether the selected renderer defines a component inline. */
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

/** Resolves one markdown component to either renderer code, a JS file, or missing. */
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

/** Formats a single component resolution for the `components` status line. */
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

/** Scans a markdown file and prints the detected component mappings. */
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
