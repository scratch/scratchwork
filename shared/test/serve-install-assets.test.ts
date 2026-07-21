/*
 * Distribution-serving behavior (notes/distribution-plan.md Phase 3): the
 * install entry points on scratchwork.dev are ordinary published files, so
 * these two behaviors are load-bearing for `curl | bash`:
 *
 *   - a published .sh file serves as text/plain (curl-able, readable in a
 *     browser, never a download prompt);
 *   - requesting a .md path directly round-trips the raw markdown bytes
 *     (the RawMarkdownServed path), so install.md is agent-readable as-is.
 */
import { describe, expect, test } from "bun:test";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SiteFileError, SiteFiles } from "../src/site/files";
import { servePath, type SiteServeEvent } from "../src/site/serve";

const INSTALL_SH = "#!/bin/sh\nset -euf\necho 'fake installer'\n";
const INSTALL_MD = "# Installing\n\n```sh\ncurl -fsSL https://scratchwork.dev/install.sh | bash\n```\n";

const files: Record<string, string> = {
  "install.sh": INSTALL_SH,
  "install.md": INSTALL_MD,
};

const notFound = (path: string) =>
  new SiteFileError({ path: path as never, reason: "NotFound", message: `not found: ${path}` });

const siteFilesLayer = Layer.succeed(SiteFiles, {
  exists: (path) => Effect.succeed(files[path as string] != null),
  readText: (path) =>
    files[path as string] != null ? Effect.succeed(files[path as string]) : Effect.fail(notFound(path as string)),
  readBytes: (path) =>
    files[path as string] != null
      ? Effect.succeed(new TextEncoder().encode(files[path as string]))
      : Effect.fail(notFound(path as string)),
  fileResponse: (path, options) =>
    files[path as string] != null
      ? Effect.succeed(
          HttpServerResponse.text(files[path as string], {
            contentType: options?.contentType,
            headers: options?.headers,
          }),
        )
      : Effect.fail(notFound(path as string)),
});

function serve(pathname: string) {
  const events: SiteServeEvent[] = [];
  return Effect.runPromise(
    servePath(pathname, "", {
      rendererFallback: Effect.succeed(null),
      onServeEvent: (event) => Effect.sync(() => void events.push(event)),
    }).pipe(Effect.provide(siteFilesLayer)),
  ).then((response) => ({ web: HttpServerResponse.toWeb(response), events }));
}

describe("distribution install assets", () => {
  test("a published .sh file serves as text/plain with its exact bytes", async () => {
    const { web } = await serve("/install.sh");
    expect(web.status).toBe(200);
    expect(web.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await web.text()).toBe(INSTALL_SH);
  });

  test("a .md path requested directly round-trips raw markdown", async () => {
    const { web, events } = await serve("/install.md");
    expect(web.status).toBe(200);
    expect(web.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await web.text()).toBe(INSTALL_MD);
    expect(events).toContainEqual({ _tag: "RawMarkdownServed", path: "install.md" });
  });
});
