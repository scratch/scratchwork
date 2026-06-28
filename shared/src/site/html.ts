import * as Effect from "effect/Effect";
import type { SitePath } from "./paths";

export interface HtmlContext {
  readonly path: SitePath;
  readonly kind: "static" | "renderer";
}

export type HtmlTransform<E = never, R = never> = (
  html: string,
  context: HtmlContext,
) => Effect.Effect<string, E, R>;

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
