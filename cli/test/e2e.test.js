/*
 * End-to-end tests for `scratchwork dev`.
 *
 * These are real e2e tests: each one spawns the actual CLI (`bun src/index.ts dev
 * <fixture>`) against a throwaway temp directory and drives it over HTTP, then
 * asserts on the real responses. Nothing is mocked.
 *
 * They are written to be AUDITABLE. Every test:
 *   1. declares its on-disk fixture inline (a { "path": "contents" } map), so
 *      you can see the exact directory layout it runs against;
 *   2. makes one request to a specific URL;
 *   3. asserts what the server returned, classified into a few obvious kinds:
 *        • STATIC HTML  — an authored .html page, served as-is
 *        • SHELL        — a marked index.html file (which loads the .md client-side)
 *        • RAW          — a file served byte-for-byte (.md, .js, .css, …)
 *        • 404 / 403
 *
 * To tell SHELLs apart without a browser, the fixtures use tiny fake shells
 * whose body carries a unique marker (e.g. "shell@a" for a marked a/index.html); the
 * assertion names the exact shell expected. Marker ids are chosen so none is a
 * prefix of another ("root", "a"), so substring assertions stay unambiguous.
 * The one exception is the embedded-fallback test, which
 * asserts the *real* shell baked into the CLI (identified by "BUNDLED ENGINE").
 *
 * The numbered comments below map each group to the spec it covers:
 *
 *   (1) scratchwork dev dir/file.html → root=dir, open /file
 *   (2) scratchwork dev dir           → root=dir, open /
 *   (3) /path/to/file → file.html | file/index.html  ⇒ served directly
 *   (4) /path/to/file → file.md   | file/index.md    ⇒ served via the nearest
 *       ancestor marked index.html shell (…/index.html up the tree, else the embedded
 *       shell baked into the CLI)
 *   (5) the served shell loads /path/to/file.md | /path/to/file/index.md
 *       (asserted server-side: the route serves a shell AND the raw .md is
 *        fetchable; the client-side render itself needs a browser and is out of
 *        scope for these HTTP tests)
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(TEST_DIR, "..");
const SCRATCHWORK = join(CLI_DIR, "src", "index.ts");

// ---------------------------------------------------------------------------
// Markers used in fixtures / assertions
// ---------------------------------------------------------------------------
const RELOAD = "data-scratchwork-dev"; // the injected live-reload <script> tag
const ENGINE = "BUNDLED ENGINE"; // appears only in the real (embedded) renderer
const RENDERER_MARKER =
  "<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->";

// A tiny fake renderer shell tagged with `id`, e.g. fakeShell("a") → contains
// "shell@a". Has a <body>…</body> so the reload client can be injected.
const fakeShell = (id) =>
  `${RENDERER_MARKER}\n<!doctype html><html><body><div id="root"></div><!-- shell@${id} --></body></html>`;

// A static (authored) HTML page tagged with `id`.
const staticPage = (id) => `<!doctype html><html><body><h1>static@${id}</h1></body></html>`;

// ---------------------------------------------------------------------------
// Harness: write a fixture, spawn the real CLI, wait until it's listening,
// hand the test a `get(path)`, then tear everything down.
// ---------------------------------------------------------------------------
let nextPort = 34100; // each spawn gets a fresh port; the CLI probes upward too

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "scratchwork-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function spawnServer(arg, { port = nextPort++, args = [] } = {}) {
  return Bun.spawn(["bun", SCRATCHWORK, "dev", arg, "--port", String(port), ...args], {
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1" }, // never pop a browser in tests
    stdout: "pipe",
    stderr: "inherit", // surface CLI crashes directly in the test output
  });
}

// Block until the CLI prints its "at http://localhost:PORT<path>" banner, then
// return the live port and the path it would open in the browser.
async function waitForReady(proc, timeoutMs = 8000) {
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`scratchwork dev exited before it was ready:\n${buf}`);
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/at\s+http:\/\/localhost:(\d+)(\S*)/);
      if (m) return { port: Number(m[1]), openPath: m[2], output: buf };
    }
  } finally {
    clearTimeout(killer);
    reader.releaseLock();
  }
}

async function readOutputUntil(proc, text, timeoutMs = 8000) {
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`scratchwork dev exited before output included ${text}:\n${buf}`);
      buf += dec.decode(value, { stream: true });
      if (buf.includes(text)) return buf;
    }
  } finally {
    clearTimeout(killer);
    reader.releaseLock();
  }
}

async function httpGet(port, path) {
  const res = await fetch(`http://localhost:${port}${path}`);
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    body: await res.text(),
  };
}

async function httpGetNoRedirect(port, path) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    redirect: "manual",
  });
  return {
    status: res.status,
    location: res.headers.get("location") || "",
    body: await res.text(),
  };
}

// Run `fn` against a live server for the given fixture. `argSubpath` lets a test
// pass `dir/<subpath>` as the CLI argument (for the file-arg cases); omit it to
// pass the directory itself.
async function withServer(files, fn, { argSubpath } = {}) {
  const dir = makeFixture(files);
  const proc = spawnServer(argSubpath ? join(dir, argSubpath) : dir);
  try {
    const { port, openPath } = await waitForReady(proc);
    await fn({ port, openPath, dir, get: (p) => httpGet(port, p) });
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Run the CLI once to completion (for non-server commands like example,
// template, and --version). Returns { code, stdout, stderr }.
async function runCli(args, cwd, { env = {} } = {}) {
  const proc = Bun.spawn(["bun", SCRATCHWORK, ...args], {
    cwd,
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// The embedded-fallback test relies on the renderer shell at
// renderer/dist/shell.js (which `bun cli/src/index.ts` loads when no project
// marked index.html is found). Build it once if absent so `bun test` works
// from a clean checkout.
// (src/index.ts would build it on demand too, but pre-building keeps tests fast.)
const RENDERER_DIR = join(CLI_DIR, "..", "renderer");
beforeAll(() => {
  if (existsSync(join(RENDERER_DIR, "dist", "shell.js"))) return;
  const r = Bun.spawnSync(["bun", "build.js"], { cwd: RENDERER_DIR, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`failed to build renderer shell:\n${r.stderr.toString()}`);
});

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
describe("(3) static HTML served directly", () => {
  test("/about.html → /about", async () => {
    await withServer({ "about.html": staticPage("about") }, async ({ port }) => {
      const res = await httpGetNoRedirect(port, "/about.html");
      expect(res.status).toBe(308);
      expect(res.location).toBe("/about");
    });
  });

  test("/foo/index.html → /foo/", async () => {
    await withServer({ "foo/index.html": staticPage("foo-index") }, async ({ port }) => {
      const res = await httpGetNoRedirect(port, "/foo/index.html");
      expect(res.status).toBe(308);
      expect(res.location).toBe("/foo/");
    });
  });

  test("/about → about.html", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "about.html": staticPage("about") },
      async ({ get }) => {
        const res = await get("/about");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@about"); // the authored page
        expect(res.body).not.toContain("shell@"); // NOT the renderer shell
      },
    );
  });

  test("/foo → foo/index.html", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "foo/index.html": staticPage("foo-index") },
      async ({ get }) => {
        const res = await get("/foo");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@foo-index");
      },
    );
  });

  test("/foo/ (trailing slash) → foo/index.html", async () => {
    await withServer({ "foo/index.html": staticPage("foo-index") }, async ({ get }) => {
      const res = await get("/foo/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("static@foo-index");
    });
  });

  test("HTML wins when both file.html and file.md exist", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "about.html": staticPage("about"),
        "about.md": "# raw about\n",
      },
      async ({ get }) => {
        const res = await get("/about");
        expect(res.body).toContain("static@about");
        expect(res.body).not.toContain("shell@");
      },
    );
  });
});

// ===========================================================================
// (4) A route that resolves to markdown is served through the nearest ancestor
//     marked index.html shell; (5) the matching raw .md is fetchable.
// ===========================================================================
describe("(4) markdown served through the nearest ancestor shell", () => {
  test("/a/b/page → uses marked a/index.html (nearest), not the root shell", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "a/index.html": fakeShell("a"),
        "a/b/page.md": "# page\n",
      },
      async ({ get }) => {
        const res = await get("/a/b/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain("shell@a"); // nearest ancestor renderer
        expect(res.body).not.toContain("shell@root"); // not the root one
      },
    );
  });

  test("/a/b/page → walks all the way up to the root shell when no closer one", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "a/b/page.md": "# page\n" },
      async ({ get }) => {
        const res = await get("/a/b/page");
        expect(res.body).toContain("shell@root");
      },
    );
  });

  test("/file → file/index.md is served via the shell", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "file/index.md": "# dir index\n" },
      async ({ get }) => {
        const res = await get("/file");
        expect(res.status).toBe(200);
        expect(res.body).toContain("shell@root");
      },
    );
  });

  test("(5) the route serves a shell AND the underlying .md is fetchable raw", async () => {
    await withServer(
      { "index.html": fakeShell("root"), "guide.md": "# the guide\n" },
      async ({ get }) => {
        const page = await get("/guide");
        expect(page.body).toContain("shell@root"); // shell serves the route

        const md = await get("/guide.md"); // …and loads this
        expect(md.status).toBe(200);
        expect(md.body).toBe("# the guide\n"); // byte-for-byte, not wrapped
        expect(md.body).not.toContain(RELOAD);
      },
    );
  });

  test("(4) embedded shell is used when no marked index.html exists anywhere", async () => {
    await withServer({ "sub/page.md": "# orphan\n" }, async ({ get }) => {
      const res = await get("/sub/page");
      expect(res.status).toBe(200);
      expect(res.body).toContain(ENGINE); // the real renderer baked into the CLI
      expect(res.body).toContain(RELOAD); // reload client injected into it
    });
  });

  test("unmarked index.html remains static and does not become a markdown renderer", async () => {
    await withServer(
      {
        "index.html": staticPage("root"),
        "page.md": "# p\n",
      },
      async ({ get }) => {
        const res = await get("/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain(ENGINE);
        expect(res.body).not.toContain("static@root");
      },
    );
  });
});

// ===========================================================================
// Resolution precedence for "/" (index.html before index.md).
// ===========================================================================
describe("root route", () => {
  test("/ → index.html is served before index.md when present", async () => {
    await withServer(
      { "index.html": staticPage("root"), "index.md": "# home\n" },
      async ({ get }) => {
        const res = await get("/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("static@root");
      },
    );
  });
});

// ===========================================================================
// Raw files are served directly, untouched.
// ===========================================================================
describe("raw file serving", () => {
  test("a referenced component .js is served as-is", async () => {
    const js = "export default () => null;\n";
    await withServer({ "index.html": fakeShell("root"), "components/X.js": js }, async ({ get }) => {
      const res = await get("/components/X.js");
      expect(res.status).toBe(200);
      expect(res.type).toContain("text/javascript");
      expect(res.body).toBe(js);
    });
  });

  test("a .md fetched directly is raw markdown, not shell-wrapped", async () => {
    await withServer({ "index.html": fakeShell("root"), "about.md": "# about\n" }, async ({ get }) => {
      const res = await get("/about.md");
      expect(res.status).toBe(200);
      expect(res.body).toBe("# about\n");
      expect(res.body).not.toContain("shell@");
      expect(res.body).not.toContain(RELOAD);
    });
  });

  test("a direct .md request falls back to file/index.md raw", async () => {
    await withServer({ "index.html": fakeShell("root"), "about/index.md": "# about index\n" }, async ({ get }) => {
      const res = await get("/about.md");
      expect(res.status).toBe(200);
      expect(res.body).toBe("# about index\n");
      expect(res.body).not.toContain("shell@");
      expect(res.body).not.toContain(RELOAD);
    });
  });
});

// ===========================================================================
// Hot-reload requirement: every served HTML page gets the reload client.
// ===========================================================================
describe("hot reload", () => {
  test("the live-reload client is injected into static pages and shells", async () => {
    await withServer(
      {
        "index.html": fakeShell("root"),
        "about.html": staticPage("about"),
        "doc.md": "# d\n",
      },
      async ({ get }) => {
        expect((await get("/about")).body).toContain(RELOAD); // static page
        expect((await get("/doc")).body).toContain(RELOAD); // shell page
      },
    );
  });
});

// ===========================================================================
// Not found and path-traversal safety.
// ===========================================================================
// ===========================================================================
// `scratchwork --version` — prints the package version.
// ===========================================================================
describe("scratchwork --version", () => {
  test("prints a semver-ish version and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-ver-"));
    try {
      const { code, stdout } = await runCli(["--version"], dir);
      expect(code).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork --help", () => {
  test("shows local project commands and omits account commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-help-"));
    try {
      const { code, stdout } = await runCli(["--help"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("dev");
      expect(stdout).toContain("example");
      expect(stdout).toContain("info");
      expect(stdout).toContain("login");
      expect(stdout).toContain("me");
      expect(stdout).toContain("projects");
      expect(stdout).toContain("publish");
      expect(stdout).toContain("stream");
      expect(stdout).toContain("template");
      expect(stdout).toContain("unpublish");
      expect(stdout).toContain("version");
      expect(stdout).not.toContain("logout");
      expect(stdout).not.toContain("whoami");
      expect(stdout).not.toContain("tokens");
      expect(stdout).not.toContain("share");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork publish", () => {
  test("reuses .scratchwork.json server and omits publish metadata from the bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-publish-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-config-"));
    const port = nextPort++;
    const serverUrl = `http://localhost:${port}`;
    const authToken = "signed-auth-token";
    let publishBody;
    let authorization;

    const server = Bun.serve({
      port,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/publish");
        authorization = request.headers.get("authorization");
        publishBody = await request.json();
        return Response.json({
          workspace: publishBody.workspace,
          project: publishBody.project,
          routePath: `${publishBody.workspace}/${publishBody.project}`,
          visibility: publishBody.visibility,
          openPath: publishBody.openPath,
          url: `${serverUrl}/${publishBody.workspace}/${publishBody.project}/`,
        });
      },
    });

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "auth.json"),
        `${JSON.stringify(
          {
            version: 1,
            servers: {
              [serverUrl]: {
                token: authToken,
                email: "founder@example.com",
                updatedAt: "2026-06-29T00:00:00.000Z",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(dir, "index.html"), staticPage("publish"));
      writeFileSync(
        join(dir, ".scratchwork.json"),
        `${JSON.stringify(
          {
            server: serverUrl,
            workspace: "founder",
            project: "site",
            visibility: "public",
            url: `${serverUrl}/founder/site/`,
            updatedAt: "2026-06-29T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );

      const { code, stdout, stderr } = await runCli(["publish", "index.html"], dir, {
        env: { SCRATCHWORK_SERVER_URL: "", SCRATCHWORK_HOME: configDir },
      });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${serverUrl}/founder/site/`);
      expect(authorization).toBe(`Bearer ${authToken}`);
      expect(publishBody.workspace).toBe("founder");
      expect(publishBody.project).toBe("site");
      expect(publishBody.visibility).toBe("public");
      expect(publishBody.bundle.files.map((file) => file.path)).toEqual(["index.html"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork project commands", () => {
  test("lists, inspects, unpublishes, deletes, and clones projects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-project-cmds-"));
    const port = nextPort++;
    const serverUrl = `http://localhost:${port}`;
    const seen = [];
    const project = {
      workspace: "founder",
      project: "site",
      routePath: "founder/site",
      visibility: "public",
      url: `${serverUrl}/founder/site/`,
      updatedAt: "2026-06-29T00:00:00.000Z",
    };

    const server = Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/projects") return Response.json({ projects: [project] });
        if (url.pathname === "/api/resolve" && url.searchParams.get("path") === "/founder/site/") {
          return Response.json({ project });
        }
        if (url.pathname === "/api/projects/founder/site" && request.method === "GET") return Response.json({ project });
        if (url.pathname === "/api/projects/founder/site/unpublish" && request.method === "POST") {
          return Response.json({ project: { ...project, visibility: "private" } });
        }
        if (url.pathname === "/api/projects/founder/site" && request.method === "DELETE") return Response.json({ ok: true });
        if (url.pathname === "/api/projects/founder/site/bundle") {
          return Response.json({
            bundle: {
              version: 1,
              files: [{ path: "index.html", contentBase64: btoa("<h1>cloned</h1>") }],
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      expect((await runCli(["projects", "--server", serverUrl], dir)).stdout).toContain("founder/site");
      expect((await runCli(["info", "--server", serverUrl, "--workspace", "founder", "--project", "site"], dir)).stdout).toContain('"routePath": "founder/site"');
      expect((await runCli(["unpublish", "--server", serverUrl, "--workspace", "founder", "--project", "site"], dir)).stdout).toContain('"visibility": "private"');
      expect((await runCli(["delete", "--server", serverUrl, "--workspace", "founder", "--project", "site"], dir)).stdout).toContain("Deleted founder/site");
      expect((await runCli(["info", `${serverUrl}/founder/site/`], dir)).stdout).toContain('"routePath": "founder/site"');
      expect((await runCli(["unpublish", `${serverUrl}/founder/site/`], dir)).stdout).toContain('"visibility": "private"');
      expect((await runCli(["delete", `${serverUrl}/founder/site/`], dir)).stdout).toContain("Deleted founder/site");
      expect((await runCli(["clone", `${serverUrl}/founder/site/`], dir)).stdout).toContain("Cloned founder/site");
      expect(readFileSync(join(dir, "site", "index.html"), "utf8")).toBe("<h1>cloned</h1>");
      expect(seen).toContain("GET /api/projects");
      expect(seen).toContain("GET /api/resolve");
      expect(seen).toContain("POST /api/projects/founder/site/unpublish");
      expect(seen).toContain("DELETE /api/projects/founder/site");
      expect(seen).toContain("GET /api/projects/founder/site/bundle");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clone rejects bundles with path-traversal file paths without writing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-clone-traversal-"));
    const port = nextPort++;
    const serverUrl = `http://localhost:${port}`;

    const server = Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/resolve") {
          return Response.json({ project: { workspace: "founder", project: "site" } });
        }
        if (url.pathname === "/api/projects/founder/site/bundle") {
          return Response.json({
            bundle: {
              version: 1,
              files: [
                { path: "index.html", contentBase64: btoa("<h1>ok</h1>") },
                { path: "../escape.html", contentBase64: btoa("<h1>escaped</h1>") },
              ],
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      const { code, stderr } = await runCli(["clone", `${serverUrl}/founder/site/`], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("invalid server response");
      expect(existsSync(join(dir, "escape.html"))).toBe(false);
      expect(existsSync(join(dir, "site", "index.html"))).toBe(false);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork stream", () => {
  test("requires a previously published project config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-stream-unpublished-"));
    try {
      writeFileSync(join(dir, "index.html"), staticPage("stream"));
      const { code, stderr } = await runCli(["stream", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("scratchwork stream: server is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchwork login", () => {
  test("requires a server when no project config provides one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-login-missing-server-"));
    try {
      const { code, stderr } = await runCli(["login"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("scratchwork login: server is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts the local callback and stores the returned token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-login-"));
    const configDir = mkdtempSync(join(tmpdir(), "scratchwork-login-config-"));
    const serverUrl = "http://localhost:3999";
    const proc = Bun.spawn(["bun", SCRATCHWORK, "login", serverUrl], {
      cwd: dir,
      env: { ...process.env, SCRATCHWORK_NO_OPEN: "1", SCRATCHWORK_HOME: configDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const output = await readOutputUntil(proc, "cli_redirect=");
      const loginMatch = output.match(/https?:\/\/\S+\/auth\/login\?\S+/);
      expect(loginMatch).not.toBeNull();
      const login = new URL(loginMatch[0]);
      const callback = new URL(login.searchParams.get("cli_redirect"));
      callback.searchParams.set("token", "login-token");
      callback.searchParams.set("server", serverUrl);
      callback.searchParams.set("email", "founder@example.com");

      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("login complete");

      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");

      const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
      expect(auth.servers[serverUrl].token).toBe("login-token");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// `scratchwork example [path]` — writes runnable example content.
// ===========================================================================
describe("scratchwork example", () => {
  test("writes example .md + components into the target dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-"));
    try {
      const { code, stdout } = await runCli(["example", "site"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("Wrote Scratchwork example files");

      // The example lands on disk…
      expect(existsSync(join(dir, "site", "index.md"))).toBe(true);
      expect(existsSync(join(dir, "site", "components", "Counter.js"))).toBe(true);

      // …and the index.md references the component it ships, so it renders.
      const md = readFileSync(join(dir, "site", "index.md"), "utf8");
      expect(md).toContain("<Counter />");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the example project actually serves through `scratchwork dev`", async () => {
    // example → then dev the result → the root page renders via a shell and the
    // example index.md is fetchable raw.
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-dev-"));
    try {
      expect((await runCli(["example", "."], dir)).code).toBe(0);
      const proc = spawnServer(dir);
      try {
        const { port } = await waitForReady(proc);
        expect((await httpGet(port, "/")).status).toBe(200); // root renders (baked shell)
        const md = await httpGet(port, "/index.md");
        expect(md.status).toBe(200);
        expect(md.body).toContain("<Counter />"); // the example content, raw
        expect((await httpGet(port, "/components/Counter.js")).status).toBe(200);
      } finally {
        proc.kill();
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite existing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-example-clash-"));
    try {
      writeFileSync(join(dir, "index.md"), "# mine\n");
      const { code, stderr } = await runCli(["example", "."], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to overwrite");
      expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# mine\n"); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// `scratchwork template [file]` — writes the default Markdown renderer.
// ===========================================================================
describe("scratchwork template", () => {
  test("writes the real renderer to marked index.html by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-"));
    try {
      const { code, stdout } = await runCli(["template"], dir);
      expect(code).toBe(0);
      expect(stdout).toContain("index.html");

      const html = readFileSync(join(dir, "index.html"), "utf8");
      expect(html.startsWith(RENDERER_MARKER)).toBe(true);
      expect(html).toContain(ENGINE); // it's the real baked renderer, not a stub
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copied marked index.html overrides the default when serving markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-dev-"));
    try {
      expect((await runCli(["template"], dir)).code).toBe(0);
      const renderer = join(dir, "index.html");
      writeFileSync(
        renderer,
        readFileSync(renderer, "utf8").replace(
          "</body>",
          "<!-- TEMPLATE MARK --></body>",
        ),
      );
      writeFileSync(join(dir, "page.md"), "# p\n");

      const proc = spawnServer(dir);
      try {
        const { port } = await waitForReady(proc);
        const res = await httpGet(port, "/page");
        expect(res.status).toBe(200);
        expect(res.body).toContain("TEMPLATE MARK");
      } finally {
        proc.kill();
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scratchwork-template-clash-"));
    try {
      writeFileSync(join(dir, "index.html"), "KEEP ME");
      const { code, stderr } = await runCli(["template"], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to overwrite");
      expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("KEEP ME");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("not found & safety", () => {
  test("an unknown extensionless route → 404", async () => {
    await withServer({ "index.html": fakeShell("root") }, async ({ get }) => {
      expect((await get("/nope")).status).toBe(404);
    });
  });

  test("a missing file with an extension → 404", async () => {
    await withServer({ "index.html": fakeShell("root") }, async ({ get }) => {
      expect((await get("/missing.md")).status).toBe(404);
    });
  });

  test("a path that escapes the root → 403 and leaks nothing", async () => {
    // Root is dir/site; a secret sits one level up at dir/secret.txt.
    const dir = makeFixture({
      "site/index.html": fakeShell("root"),
      "secret.txt": "TOP SECRET",
    });
    const proc = spawnServer(join(dir, "site"));
    try {
      const { port } = await waitForReady(proc);
      // %2e%2e%2f is an encoded "../" — stays encoded through fetch so the
      // server, not the URL parser, has to defend against it.
      const res = await httpGet(port, "/%2e%2e%2fsecret.txt");
      expect(res.status).toBe(403);
      expect(res.body).not.toContain("TOP SECRET");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
