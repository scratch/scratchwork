/*
 * End-to-end tests for `scratchwork publish` and the publishing server.
 *
 * Like e2e.test.js, these are REAL: each test spawns the actual CLI and the
 * actual local server (server/src/local.js) and drives them over HTTP. Nothing
 * is mocked.
 *
 * The headline test is the project requirement: a site published to a server
 * must render IDENTICALLY to `scratchwork dev`. We prove it by serving the same
 * fixture both ways and asserting the bytes match for every route — HTML pages
 * differ only by the dev-only hot-reload <script>, and raw files are byte-equal.
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(TEST_DIR, "..");
const REPO_DIR = join(CLI_DIR, "..");
const SCRATCHWORK = join(CLI_DIR, "scratchwork.js");
const SERVER = join(REPO_DIR, "server", "src", "local.js");
const TEMPLATE_DIR = join(REPO_DIR, "template");

const RELOAD = "data-scratchwork-dev";

// The dev server injects a hot-reload <script> before </body>. Strip it so we
// can compare a dev-served page against the same page published (which has no
// such script). What's left must be byte-identical.
function stripReload(html) {
  return html.replace(/\n<script data-scratchwork-dev>[\s\S]*?<\/script>\n/, "");
}

// ---------------------------------------------------------------------------
// Process harness
// ---------------------------------------------------------------------------
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "sw-pub-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Read a spawned process's stdout until `re` matches; return the match. Leaves
// the process running.
async function waitForLine(proc, re, timeoutMs = 10000) {
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`process exited before matching ${re}:\n${buf}`);
      buf += dec.decode(value, { stream: true });
      const m = buf.match(re);
      if (m) return m;
    }
  } finally {
    clearTimeout(killer);
    reader.releaseLock();
  }
}

function spawnServer(dataDir, env = {}) {
  return Bun.spawn(["bun", SERVER, "--port", "0", "--data", dataDir], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
}

async function startServer(dataDir, env) {
  const proc = spawnServer(dataDir, env);
  const m = await waitForLine(proc, /listening on\s+http:\/\/localhost:(\d+)/);
  return { proc, port: Number(m[1]), url: `http://localhost:${Number(m[1])}` };
}

let devPort = 35200;
function spawnDev(fixture) {
  return Bun.spawn(["bun", SCRATCHWORK, "dev", fixture, "--port", String(devPort++)], {
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "inherit",
  });
}

async function startDev(fixture) {
  const proc = spawnDev(fixture);
  const m = await waitForLine(proc, /at\s+http:\/\/localhost:(\d+)/);
  return { proc, port: Number(m[1]) };
}

// Run `scratchwork publish` to completion. Returns { code, stdout, stderr }.
async function runPublish(fixture, serverUrl, xdg, extraArgs = [], env = {}) {
  const proc = Bun.spawn(
    ["bun", SCRATCHWORK, "publish", fixture, "--server", serverUrl, "--no-open", ...extraArgs],
    {
      env: { ...process.env, XDG_CONFIG_HOME: xdg, SCRATCHWORK_NO_OPEN: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function runCli(args, xdg, env = {}) {
  const proc = Bun.spawn(["bun", SCRATCHWORK, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: xdg, SCRATCHWORK_NO_OPEN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function get(port, path) {
  const res = await fetch(`http://localhost:${port}${path}`);
  return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
}

function projectId(fixture) {
  return JSON.parse(readFileSync(join(fixture, ".scratchwork.json"), "utf8")).id;
}

// The renderer shell the CLI bakes for markdown routes must exist before tests.
beforeAll(() => {
  if (existsSync(join(TEMPLATE_DIR, "dist", "shell.js"))) return;
  const r = Bun.spawnSync(["bun", "build.js"], { cwd: TEMPLATE_DIR, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`failed to build renderer shell:\n${r.stderr.toString()}`);
});

// ===========================================================================
// THE REQUIREMENT: dev and publish render identically.
// ===========================================================================
describe("dev and publish render identically", () => {
  // A fixture exercising every route kind: a markdown homepage with a relative
  // image + a component, a markdown subpage, an authored static HTML page, a
  // component file, and an image.
  const FIXTURE = {
    "index.md": '---\ntitle: "Home"\n---\n\n![logo](logo.svg)\n\n# Home\n\n<Counter />\n',
    "guide.md": "# Guide\n\nSome guide text.\n",
    "about.html": "<!doctype html><html><body><h1>About</h1></body></html>",
    "components/Counter.js":
      "const React = window.React;\nexport default () => React.createElement('span', null, 'counter');\n",
    "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>',
  };

  test("every route matches between `scratchwork dev` and a published site", async () => {
    const fixture = makeFixture(FIXTURE);
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    let dev;
    try {
      const pub = await runPublish(fixture, server.url, xdg);
      expect(pub.code).toBe(0);
      const id = projectId(fixture);

      dev = await startDev(fixture);

      // HTML routes: dev minus the hot-reload script === published, byte-for-byte.
      for (const route of ["/", "/guide", "/about"]) {
        const d = await get(dev.port, route);
        const p = await get(server.port, `/${id}${route}`);
        expect(p.status).toBe(200);
        expect(d.status).toBe(200);
        expect(d.body).toContain(RELOAD); // dev injected its reload client
        expect(p.body).not.toContain(RELOAD); // published did not
        expect(stripReload(d.body)).toBe(p.body); // …otherwise identical
      }

      // Raw assets the shell fetches: byte-identical, no injection either side.
      for (const raw of ["/index.md", "/guide.md", "/components/Counter.js", "/logo.svg"]) {
        const d = await get(dev.port, raw);
        const p = await get(server.port, `/${id}${raw}`);
        expect(p.status).toBe(200);
        expect(p.body).toBe(d.body);
        expect(p.body).not.toContain(RELOAD);
      }
    } finally {
      server.proc.kill();
      if (dev) dev.proc.kill();
      await server.proc.exited;
      if (dev) await dev.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("the published homepage is exactly the baked renderer shell", async () => {
    const fixture = makeFixture({ "index.md": "# Hi\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      expect((await runPublish(fixture, server.url, xdg)).code).toBe(0);
      const id = projectId(fixture);
      const home = await get(server.port, `/${id}/`);
      const baked = readFileSync(join(TEMPLATE_DIR, "dist", "index.html"), "utf8");
      expect(home.body).toBe(baked);
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Publish behaviors.
// ===========================================================================
describe("publish", () => {
  test("a single markdown file is published as the site index", async () => {
    const fixture = makeFixture({ "spec.md": "# My Spec\n\nDetails.\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      const r = await runPublish(join(fixture, "spec.md"), server.url, xdg);
      expect(r.code).toBe(0);
      const id = projectId(fixture);
      // "/" serves a shell (the baked renderer), index.md is the file's content.
      const home = await get(server.port, `/${id}/`);
      expect(home.status).toBe(200);
      expect(home.type).toContain("text/html");
      const md = await get(server.port, `/${id}/index.md`);
      expect(md.body).toBe("# My Spec\n\nDetails.\n");
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("re-publishing keeps the same id/URL and bumps the version", async () => {
    const fixture = makeFixture({ "index.md": "# v1\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      const first = await runPublish(fixture, server.url, xdg);
      expect(first.stdout).toContain("a new project");
      const id1 = projectId(fixture);

      writeFileSync(join(fixture, "index.md"), "# v2\n");
      const second = await runPublish(fixture, server.url, xdg);
      expect(second.stdout).toContain("v2");
      expect(projectId(fixture)).toBe(id1); // same id
      expect((await get(server.port, `/${id1}/index.md`)).body).toBe("# v2\n");
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("--dry-run lists files without uploading", async () => {
    const fixture = makeFixture({ "index.md": "# hi\n", "components/A.js": "export default 1;\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      const r = await runPublish(fixture, server.url, xdg, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("dry run");
      expect(r.stdout).toContain("index.html"); // baked shell shown
      expect(r.stdout).toContain("components/A.js");
      expect(existsSync(join(fixture, ".scratchwork.json"))).toBe(false); // nothing persisted
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test(".mdx uploads raw but is not a baked page route (parity with dev)", async () => {
    const fixture = makeFixture({ "index.md": "# home\n", "notes.mdx": "# notes mdx\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      expect((await runPublish(fixture, server.url, xdg)).code).toBe(0);
      const id = projectId(fixture);
      // The renderer shell only fetches .md, so dev never serves /notes for a
      // .mdx file. Publish must match: the .mdx is uploaded raw, /notes is 404.
      const raw = await get(server.port, `/${id}/notes.mdx`);
      expect(raw.status).toBe(200);
      expect(raw.body).toBe("# notes mdx\n");
      expect((await get(server.port, `/${id}/notes`)).status).toBe(404);
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("an authored index.html is published as-is (no shell baked over it)", async () => {
    const fixture = makeFixture({
      "index.html": "<!doctype html><html><body><h1>Authored</h1></body></html>",
      "index.md": "# ignored at /\n",
    });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data);
    try {
      expect((await runPublish(fixture, server.url, xdg)).code).toBe(0);
      const id = projectId(fixture);
      const home = await get(server.port, `/${id}/`);
      expect(home.body).toContain("Authored"); // the authored page, not a shell
      expect(home.body).not.toContain("BUNDLED ENGINE");
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Auth: login + token-gated publishing.
// ===========================================================================
describe("auth", () => {
  test("publishing to a token-gated server fails without login, succeeds after", async () => {
    const fixture = makeFixture({ "index.md": "# secret\n" });
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data, { SCRATCHWORK_TOKEN: "topsecret" });
    try {
      // No credentials → 401 → friendly message, non-zero exit.
      const denied = await runPublish(fixture, server.url, xdg);
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain("Authentication required");

      // login stores the token (verified against the server).
      const login = await runCli(["login", "--server", server.url, "--token", "topsecret"], xdg);
      expect(login.code).toBe(0);
      expect(login.stdout).toContain("Logged in");

      // Now publish succeeds using the stored token.
      const ok = await runPublish(fixture, server.url, xdg);
      expect(ok.code).toBe(0);
      const id = projectId(fixture);
      expect((await get(server.port, `/${id}/index.md`)).body).toBe("# secret\n");
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(fixture, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("whoami reports auth status", async () => {
    const xdg = tmp("sw-pub-xdg-");
    const data = tmp("sw-pub-data-");
    const server = await startServer(data, { SCRATCHWORK_TOKEN: "tok" });
    try {
      const before = await runCli(["whoami", "--server", server.url], xdg);
      expect(before.stdout).toContain("auth required: true");
      expect(before.stdout).toContain("authenticated: false");

      await runCli(["login", "--server", server.url, "--token", "tok"], xdg);
      const after = await runCli(["whoami", "--server", server.url], xdg);
      expect(after.stdout).toContain("authenticated: true");
    } finally {
      server.proc.kill();
      await server.proc.exited;
      rmSync(xdg, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});
