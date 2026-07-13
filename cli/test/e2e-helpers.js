/*
 * Shared harness for the e2e-*.test.js suite.
 *
 * These are real e2e tests: each one spawns the actual CLI against a
 * throwaway temp directory and drives it over HTTP, then asserts on the real
 * responses. Nothing is mocked.
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
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(TEST_DIR, "..");

// The command that runs the CLI under test. run.ts bundles src/index.ts once
// and points SCRATCHWORK_E2E_CLI at the bundle, so the suite's ~60 spawns skip
// re-transpiling the Effect dependency graph every time. Direct `bun test`
// runs fall back to the source entry — same behavior, slower per spawn.
export const CLI = process.env.SCRATCHWORK_E2E_CLI
  ? ["bun", process.env.SCRATCHWORK_E2E_CLI]
  : ["bun", join(CLI_DIR, "src", "index.ts")];

// ---------------------------------------------------------------------------
// Markers used in fixtures / assertions
// ---------------------------------------------------------------------------
export const RELOAD = "data-scratchwork-dev"; // the injected live-reload <script> tag
export const ENGINE = "BUNDLED ENGINE"; // appears only in the real (embedded) renderer
export const RENDERER_MARKER =
  "<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->";

// A tiny fake renderer shell tagged with `id`, e.g. fakeShell("a") → contains
// "shell@a". Has a <body>…</body> so the reload client can be injected.
export const fakeShell = (id) =>
  `${RENDERER_MARKER}\n<!doctype html><html><body><div id="root"></div><!-- shell@${id} --></body></html>`;

// A static (authored) HTML page tagged with `id`.
export const staticPage = (id) => `<!doctype html><html><body><h1>static@${id}</h1></body></html>`;

// ---------------------------------------------------------------------------
// Harness: write a fixture, spawn the real CLI, wait until it's listening,
// hand the test a `get(path)`, then tear everything down.
// ---------------------------------------------------------------------------

// Each spawn gets a fresh port; the CLI probes upward too. run.ts gives every
// test process a disjoint range via SCRATCHWORK_E2E_PORT_BASE so the mock
// servers in concurrently running test files never collide.
let portCounter = Number(process.env.SCRATCHWORK_E2E_PORT_BASE ?? 34100);
export const nextPort = () => portCounter++;

export function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "scratchwork-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

export function spawnServer(arg, { port = nextPort(), args = [] } = {}) {
  return Bun.spawn([...CLI, "dev", arg, "--port", String(port), ...args], {
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1" }, // never pop a browser in tests
    stdout: "pipe",
    stderr: "inherit", // surface CLI crashes directly in the test output
  });
}

// Block until the CLI prints its "at http://localhost:PORT<path>" banner, then
// return the live port and the path it would open in the browser.
export async function waitForReady(proc, timeoutMs = 8000) {
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

export async function readOutputUntil(proc, text, timeoutMs = 8000) {
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

export async function httpGet(port, path) {
  const res = await fetch(`http://localhost:${port}${path}`);
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    body: await res.text(),
  };
}

export async function httpGetNoRedirect(port, path) {
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
export async function withServer(files, fn, { argSubpath } = {}) {
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
export async function runCli(args, cwd, { env = {} } = {}) {
  const proc = Bun.spawn([...CLI, ...args], {
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

// The embedded-fallback tests rely on the built renderer at
// renderer/dist/index.html (which the CLI loads when no project marked
// index.html is found). Build it once if absent so `bun test` works from a
// clean checkout; run.ts pre-builds it so parallel test processes never race.
const RENDERER_DIR = join(CLI_DIR, "..", "renderer");
if (!existsSync(join(RENDERER_DIR, "dist", "index.html"))) {
  const r = Bun.spawnSync(["bun", "build.js"], { cwd: RENDERER_DIR, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`failed to build renderer shell:\n${r.stderr.toString()}`);
}
