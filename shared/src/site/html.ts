/*
 * HTML transform hooks for the site-serving pipeline. Consumers (the CLI dev
 * server, deploy targets) register transforms to rewrite HTML before it is
 * served — for example to inject the live-reload script.
 */
import * as Effect from "effect/Effect";
import type { SitePath } from "./paths";

/** Where the HTML being transformed came from: a static file or a renderer shell. */
export interface HtmlContext {
  readonly path: SitePath;
  readonly kind: "static" | "renderer";
}

/** A single HTML rewrite step applied before an HTML response is sent. */
export type HtmlTransform<E = never, R = never> = (
  html: string,
  context: HtmlContext,
) => Effect.Effect<string, E, R>;

/** Runs the given transforms over the HTML in order, feeding each the previous result. */
export function applyHtmlTransforms<E, R>(
  html: string,
  context: HtmlContext,
  transforms: ReadonlyArray<HtmlTransform<E, R>>,
): Effect.Effect<string, E, R> {
  return Effect.gen(function* () {
    let current = html;
    for (const transform of transforms) {
      current = yield* transform(current, context);
    }
    return current;
  });
}
