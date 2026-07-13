/*
 * e2e: the `scratchwork dev` path argument — server root, the URL it
 * announces/opens, and what that URL serves. Shared harness: e2e-helpers.js.
 */
import { test, expect, describe } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  fakeShell,
  staticPage,
  makeFixture,
  spawnServer,
  waitForReady,
  readOutputUntil,
  httpGet,
  withServer,
} from "./e2e-helpers.js";

// ===========================================================================
// (1)(2) The path argument sets the server root and the page to open — then
// fetching that opened URL must serve the right content. Each test runs the
// full round-trip: arg → announced openPath → GET openPath → assert content.
// ===========================================================================
describe("path argument → open URL → served content", () => {
  test("probes upward when the requested port is already in use", async () => {
    const dir = makeFixture({ "index.html": staticPage("root") });
    const blocker = Bun.serve({
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const requestedPort = blocker.port;
    const proc = spawnServer(dir, { port: requestedPort });
    try {
      const { port, openPath } = await waitForReady(proc);
      expect(port).toBeGreaterThan(requestedPort);
      expect(openPath).toBe("/");
      expect((await httpGet(port, "/")).body).toContain("static@root");
    } finally {
      proc.kill();
      await proc.exited;
      blocker.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prints Effect debug logs with --verbose", async () => {
    const dir = makeFixture({ "index.html": staticPage("root") });
    const proc = spawnServer(dir, { args: ["--verbose"] });
    try {
      const { output } = await waitForReady(proc);
      expect(output).toContain("DEBUG");
      expect(output).toContain("dev command starting");
      expect(output).toContain("command: dev");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs a compact rendered markdown and component summary", async () => {
    const dir = makeFixture({
      "index.html": fakeShell("root"),
      "index.md": "# home\n\n<Counter />\n<Missing />\n",
      "components/Counter.js": "export default function Counter() { return null; }\n",
    });
    const proc = spawnServer(dir);
    try {
      const { port } = await waitForReady(proc);
      expect((await httpGet(port, "/")).body).toContain("shell@root");

      const output = await readOutputUntil(proc, "missing React component Missing");
      expect(output).toContain("render");
      expect(output).toContain("index.md via index.html");
      expect(output).toContain(
        "components index.md: Counter -> components/Counter.js; Missing missing",
      );
      expect(output).toContain(
        "! missing React component Missing in index.md",
      );
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs content changes without repeating component summaries", async () => {
    const dir = makeFixture({
      "index.html": fakeShell("root"),
      "index.md": "# home\n\n<Counter />\n",
      "components/Counter.js": "export default function Counter() { return null; }\n",
    });
    const proc = spawnServer(dir);
    try {
      const { port } = await waitForReady(proc);
      expect((await httpGet(port, "/")).body).toContain("shell@root");
      await readOutputUntil(proc, "components index.md");

      writeFileSync(join(dir, "index.md"), "# home\n\n<Counter />\n<Missing />\n");

      const output = await readOutputUntil(proc, "index.md -> refresh");
      expect(output).toContain("changed");
      expect(output).not.toContain("components index.md");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not repeat render or component summaries after component reloads", async () => {
    const dir = makeFixture({
      "index.html": fakeShell("root"),
      "index.md": "# home\n\n<Counter />\n",
      "components/Counter.js": "export default function Counter() { return null; }\n",
      "done.html": staticPage("done"),
    });
    const proc = spawnServer(dir);
    try {
      const { port } = await waitForReady(proc);
      expect((await httpGet(port, "/")).body).toContain("shell@root");
      await readOutputUntil(proc, "components index.md");

      writeFileSync(
        join(dir, "components", "Counter.js"),
        "export default function Counter() { return 'updated'; }\n",
      );

      const changed = await readOutputUntil(proc, "Counter.js -> reload");
      expect(changed).toContain("changed");

      expect((await httpGet(port, "/")).body).toContain("shell@root");
      expect((await httpGet(port, "/done")).body).toContain("static@done");

      const output = await readOutputUntil(proc, "html       done.html");
      expect(output).not.toContain("render     index.md");
      expect(output).not.toContain("components index.md");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(2) `scratchwork dev dir` opens / and / serves the root page", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "index.md": "# home\n" },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/");
        expect((await get(openPath)).body).toContain("shell@root"); // / → root shell
        expect((await get("/index.md")).body).toBe("# home\n"); // …which loads this
      },
    );
  });

  test("(1) `scratchwork dev dir/file.html` opens /file and /file serves file.html", async () => {
    await withServer(
      { "file.html": staticPage("file") },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/file");
        const res = await get(openPath); // GET /file
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@file"); // the authored page
        expect(res.body).not.toContain("shell@"); // served directly, not via a shell
      },
      { argSubpath: "file.html" },
    );
  });

  test("(1) `scratchwork dev dir/file.md` opens /file and /file serves the shell for file.md", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "file.md": "# file\n" },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/file");
        expect((await get(openPath)).body).toContain("shell@root"); // /file → shell
        expect((await get("/file.md")).body).toBe("# file\n"); // …which loads this
      },
      { argSubpath: "file.md" },
    );
  });

  test("(2) a directory without an index opens the first page file's route", async () => {
    await withServer(
      { "zebra.md": "# zebra\n", "notes.html": staticPage("notes") },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/notes"); // alphabetically first page file at the root
        expect((await get(openPath)).body).toContain("static@notes");
      },
    );
  });

  test("(2) a directory whose only pages are nested opens the shallowest one", async () => {
    await withServer(
      { "docs/guide.md": "# guide\n", "styles.css": "body {}" },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/docs/guide");
        expect((await get("/docs/guide.md")).body).toBe("# guide\n");
      },
    );
  });

  test("(2) a nested index file opens its directory route", async () => {
    await withServer(
      { "docs/index.html": staticPage("docs") },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/docs/");
        expect((await get(openPath)).body).toContain("static@docs");
      },
    );
  });

  test("(2) a marked renderer shell without index.md is not treated as the index", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "notes.md": "# notes\n" },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/notes"); // "/" would 404: the shell only renders .md routes
        expect((await get(openPath)).body).toContain("shell@root");
      },
    );
  });

  test("(2) a directory with no page files still opens /", async () => {
    await withServer(
      { "styles.css": "body {}" },
      async ({ openPath }) => {
        expect(openPath).toBe("/");
      },
    );
  });

  test("(1) `scratchwork dev dir/index.html` opens /", async () => {
    await withServer(
      { "index.html": staticPage("root") },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/");
        expect((await get(openPath)).body).toContain("static@root");
      },
      { argSubpath: "index.html" },
    );
  });

  test("(1) `scratchwork dev dir/index.md` opens /", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "index.md": "# home\n" },
      async ({ openPath, get }) => {
        expect(openPath).toBe("/");
        expect((await get(openPath)).body).toContain("shell@root");
      },
      { argSubpath: "index.md" },
    );
  });
});

// ===========================================================================
// (3) A route that resolves to HTML is served directly.
// ===========================================================================
