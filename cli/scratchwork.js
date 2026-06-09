#!/usr/bin/env bun
/*
 * scratchwork — a tiny CLI for Scratchwork projects.
 *
 *   scratchwork dev [path] [--port N]   start the dev server (below)
 *   scratchwork create [path]           scaffold a new project (example .md + components)
 *   scratchwork eject [file]            write the default renderer template to a file
 *   scratchwork --version               print the version
 *
 * `path` is a directory to serve, or a file inside it to open:
 *   dir            → root = dir,  open /
 *   dir/file.html  → root = dir,  open /file
 *   dir/file.md    → root = dir,  open /file
 * (default: current directory). The server finds the first free port at or
 * above the default and opens that page in the browser.
 *
 * Request resolution for /path/to/file:
 *   • an existing file with an extension (.md/.js/.css/.html/img) → served
 *     directly (.html gets the live-reload client injected).
 *   • file.html | file/index.html → served directly (a static page).
 *   • file.md   | file/index.md   → served through the nearest ancestor
 *     index.html *renderer shell*, falling back to the renderer shell embedded
 *     in the standalone binary (or ../renderer/dist/shell.js when run from
 *     source). The shell fetches and renders the markdown client-side, so
 *     content is never rebuilt.
 *
 * Hot reload on edits to .md / .html / .js / .css:
 *   • .md change  → re-render the page in place (no full reload), via the
 *                   renderer's window.SCRATCHWORK.refresh() hook.
 *   • other       → full page reload.
 *   • If the served page predates the refresh hook, every change falls back to
 *     a full reload — so this works against any static site, not just new ones.
 *
 * Zero runtime dependencies — Bun built-ins only (Bun.serve, node:fs watch,
 * SSE) plus the build-time embedded shell.
 */
import { watch, existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, extname, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
// The Scratchwork figure mark, served as the default favicon when a project
// ships none. Imported as text so `bun build --compile` embeds it in the binary.
import FIGURE_SVG from "./assets/figure.svg" with { type: "text" };
// The version printed by `scratchwork --version`. Imported (not read at runtime) so
// the compiled standalone binary carries it.
import pkg from "./package.json";
// The starter project written by `scratchwork create`. Each file is imported as
// text so `bun build --compile` embeds it; the SCAFFOLD map below pairs each
// with its destination path relative to the new project root.
import SCAFFOLD_INDEX_MD from "./scaffold/index.md" with { type: "text" };
import SCAFFOLD_COUNTER_JS from "./scaffold/components/Counter.js" with { type: "text" };
import SCAFFOLD_HIGHLIGHT_JS from "./scaffold/components/Highlight.js" with { type: "text" };

const SCAFFOLD = {
  "index.md": SCAFFOLD_INDEX_MD,
  "components/Counter.js": SCAFFOLD_COUNTER_JS,
  "components/Highlight.js": SCAFFOLD_HIGHLIGHT_JS,
};

const DEFAULT_PORT = 3000;
const RELOAD_PATH = "/__scratchwork_reload";
const WATCH_EXT = new Set([".md", ".html", ".js", ".css"]);
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "--help" || cmd === "-h" || cmd === "help" || !cmd) {
  printHelp();
  process.exit(cmd ? 0 : 1);
}
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(pkg.version);
  process.exit(0);
}
if (cmd === "create") {
  await runCreate(argv.slice(1));
  process.exit(0);
}
if (cmd === "eject") {
  await runEject(argv.slice(1));
  process.exit(0);
}
if (cmd !== "dev") {
  console.error(`scratchwork: unknown command "${cmd}"\n`);
  printHelp();
  process.exit(1);
}

let pathArg = ".";
let startPort = DEFAULT_PORT;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else if (a === "--port" || a === "-p") {
    startPort = parseInt(argv[++i], 10);
  } else if (a.startsWith("--port=")) {
    startPort = parseInt(a.slice("--port=".length), 10);
  } else if (a.startsWith("-")) {
    console.error(`scratchwork dev: unknown option "${a}"`);
    process.exit(1);
  } else {
    pathArg = a;
  }
}

if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
  console.error(`scratchwork dev: invalid --port "${startPort}"`);
  process.exit(1);
}

// Resolve the path arg into a server root + the page to open:
//   • a directory        → root = dir,          open "/"
//   • dir/file.html|.md  → root = dirname(file), open "/<basename without ext>"
const target = resolve(process.cwd(), pathArg);
let root, openPath;
if (existsSync(target) && statSync(target).isDirectory()) {
  root = target;
  openPath = "/";
} else if (existsSync(target) && statSync(target).isFile()) {
  root = dirname(target);
  openPath = "/" + basename(target).replace(/\.(html?|md)$/i, "");
} else {
  console.error(`scratchwork dev: no such file or directory: ${target}`);
  process.exit(1);
}

// The renderer shell, used when a markdown route has no index.html anywhere up
// the served tree. Resolved lazily and memoized:
//   • In the standalone binary (cli/build.js), the literal import below is
//     embedded by `bun build --compile`, so it just resolves.
//   • Run directly from source (`bun cli/scratchwork.js`), it loads
//     ../template/dist/shell.js — building the renderer first if dist is absent.
let _shellPromise = null;
function bakedShell() {
  if (!_shellPromise) _shellPromise = loadShell();
  return _shellPromise;
}
async function loadShell() {
  try {
    return (await import("../template/dist/shell.js")).default;
  } catch {
    /* not built yet — fall through and build it (source checkout only) */
  }
  try {
    const buildScript = fileURLToPath(new URL("../template/build.js", import.meta.url));
    console.log("  building renderer shell (template/dist not found)…");
    Bun.spawnSync(["bun", buildScript], { stdout: "inherit", stderr: "inherit" });
    // Read the freshly built HTML directly — re-importing the failed specifier
    // can hit a cached resolution, but reading the file always reflects disk.
    const htmlPath = fileURLToPath(new URL("../template/dist/index.html", import.meta.url));
    return readFileSync(htmlPath, "utf8");
  } catch {
    return null; // give up — static-only sites don't need a shell anyway
  }
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

const clients = new Set();

function sseResponse() {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      clients.add(c);
      c.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      clients.delete(controller);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function broadcast(payload) {
  for (const c of [...clients]) {
    try {
      c.enqueue(payload);
    } catch {
      clients.delete(c);
    }
  }
}

function notify(data) {
  broadcast(encoder.encode("data: " + JSON.stringify(data) + "\n\n"));
}

// Keep connections alive (Bun closes idle sockets) and prune dead clients.
const HEARTBEAT = encoder.encode(": ping\n\n");
setInterval(() => broadcast(HEARTBEAT), 20000);

function injectClient(html) {
  const tag = `\n<script data-scratchwork-dev>${CLIENT}</script>\n`;
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const NO_STORE = "no-store, must-revalidate";

function withinRoot(p) {
  const r = resolve(p);
  return r === root || r.startsWith(root + sep);
}

function isFile(p) {
  return withinRoot(p) && existsSync(p) && statSync(p).isFile();
}

function htmlResponse(html) {
  return new Response(injectClient(html), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE },
  });
}

// Walk up from `dir` looking for a renderer shell to wrap markdown in, falling
// back to the CLI's baked-in shell. At each level a `template.html` (the file
// `scratchwork eject` writes, the documented way to override the default template)
// wins over an `index.html`. Returns the HTML string or null.
async function nearestShell(dir) {
  let d = dir;
  while (true) {
    for (const name of ["template.html", "index.html"]) {
      const cand = join(d, name);
      if (isFile(cand)) return await Bun.file(cand).text();
    }
    if (d === root) break;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return await bakedShell();
}

async function handle(req) {
  const pathname = decodeURIComponent(new URL(req.url).pathname);
  if (pathname === RELOAD_PATH) return sseResponse();

  // 1. Direct file request (the path names an extension) — e.g. the renderer
  //    fetching a .md, a component .js, css, or an image. Serve it if it exists;
  //    .html is served directly (with the reload client injected).
  const last = pathname.split("/").pop();
  if (last.includes(".")) {
    const f = join(root, pathname);
    if (!withinRoot(f)) return new Response("Forbidden", { status: 403 });
    if (isFile(f)) {
      if (extname(f).toLowerCase() === ".html") return htmlResponse(await Bun.file(f).text());
      return new Response(Bun.file(f), { headers: { "Cache-Control": NO_STORE } });
    }
    // Default favicon: when the project ships none of its own, answer the
    // browser's automatic /favicon.ico request with the built-in figure mark.
    if (pathname === "/favicon.ico" && !isFile(join(root, "favicon.svg"))) {
      return new Response(FIGURE_SVG, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": NO_STORE },
      });
    }
    return new Response(`Not found: ${pathname}`, { status: 404 });
  }

  // 2. Page route (extensionless). Resolve static HTML first, then markdown
  //    (served through the nearest renderer shell, which loads the .md itself).
  const dirStyle = pathname === "/" || pathname.endsWith("/");
  const route = pathname.replace(/\/+$/, ""); // "" for the root

  const statics = dirStyle
    ? [join(root, route, "index.html")]
    : [join(root, route + ".html"), join(root, route, "index.html")];
  for (const f of statics) {
    if (isFile(f)) return htmlResponse(await Bun.file(f).text());
  }

  const markdowns = dirStyle
    ? [{ file: join(root, route, "index.md"), dir: join(root, route) }]
    : [
        { file: join(root, route + ".md"), dir: dirname(join(root, route + ".md")) },
        { file: join(root, route, "index.md"), dir: join(root, route) },
      ];
  for (const { file, dir } of markdowns) {
    if (isFile(file)) {
      const shell = await nearestShell(dir);
      if (shell == null) return new Response("No renderer shell available", { status: 500 });
      return htmlResponse(shell);
    }
  }

  return new Response(`Not found: ${pathname}`, { status: 404 });
}

// ---------------------------------------------------------------------------
// Start: probe upward for a free port
// ---------------------------------------------------------------------------
let server = null;
let port = startPort;
for (let attempt = 0; attempt < 100 && !server; attempt++) {
  try {
    server = Bun.serve({ port, idleTimeout: 0, fetch: handle });
  } catch (err) {
    const inUse = err && (err.code === "EADDRINUSE" || /in use|address already/i.test(String(err.message || err)));
    if (inUse) {
      port++;
      continue;
    }
    throw err;
  }
}
if (!server) {
  console.error(`scratchwork dev: no free port found in [${startPort}, ${startPort + 100})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Watch for changes
// ---------------------------------------------------------------------------
let timer = null;
let pending = null;
watch(root, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  const rel = filename.toString();
  if (rel.includes("node_modules") || rel.startsWith(".git") || rel.includes(sep + ".git")) return;
  if (!WATCH_EXT.has(extname(rel).toLowerCase())) return;
  pending = { path: rel, ext: extname(rel).slice(1).toLowerCase() };
  clearTimeout(timer);
  timer = setTimeout(() => {
    const how = pending.ext === "md" ? "re-render" : "reload";
    console.log(`  ~ ${pending.path} → ${how}`);
    notify(pending);
  }, 50);
});

// ---------------------------------------------------------------------------
// Announce + open browser
// ---------------------------------------------------------------------------
const url = `http://localhost:${port}${openPath}`;
console.log(`\n  scratchwork dev`);
console.log(`  serving  ${root}`);
console.log(`  at       ${url}`);
console.log(`  watching .md .html .js .css — hot reload on\n`);

// SCRATCHWORK_NO_OPEN=1 skips launching a browser — used by the e2e tests, which
// drive the server over HTTP and don't want a tab opened per run.
if (!process.env.SCRATCHWORK_NO_OPEN) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [opener, url];
  try {
    Bun.spawn(openArgs, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* opening the browser is best-effort */
  }
}

// ---------------------------------------------------------------------------
// `scratchwork create [path]` — scaffold a new project from the embedded starter
// (example index.md + components). Refuses to clobber existing files.
// ---------------------------------------------------------------------------
async function runCreate(args) {
  let dest = ".";
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      console.log("Usage: scratchwork create [path]\n\nScaffold a new Scratchwork project (example Markdown + React components).");
      return;
    }
    if (a.startsWith("-")) {
      console.error(`scratchwork create: unknown option "${a}"`);
      process.exit(1);
    }
    dest = a;
  }

  const root = resolve(process.cwd(), dest);
  const targets = Object.keys(SCAFFOLD).map((rel) => ({ rel, abs: join(root, rel) }));
  const clashes = targets.filter(({ abs }) => existsSync(abs));
  if (clashes.length) {
    console.error(`scratchwork create: refusing to overwrite existing file(s):`);
    for (const { rel } of clashes) console.error(`  ${join(dest, rel)}`);
    process.exit(1);
  }

  for (const { rel, abs } of targets) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SCAFFOLD[rel]);
  }

  console.log(`\n  Created a Scratchwork project in ${root}`);
  for (const { rel } of targets) console.log(`    + ${rel}`);
  const cd = dest === "." ? "" : `cd ${dest} && `;
  console.log(`\n  Next:  ${cd}scratchwork dev\n`);
}

// ---------------------------------------------------------------------------
// `scratchwork eject [file]` — write the default renderer template to a file
// (default template.html). When template.html sits in a project root it
// overrides the built-in template for rendered Markdown (see nearestShell).
// ---------------------------------------------------------------------------
async function runEject(args) {
  let dest = "template.html";
  let sawFile = false;
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      console.log("Usage: scratchwork eject [file]\n\nWrite the default renderer template to <file> (default: template.html).");
      return;
    }
    if (a.startsWith("-")) {
      console.error(`scratchwork eject: unknown option "${a}"`);
      process.exit(1);
    }
    if (sawFile) {
      console.error(`scratchwork eject: unexpected extra argument "${a}"`);
      process.exit(1);
    }
    dest = a;
    sawFile = true;
  }

  const out = resolve(process.cwd(), dest);
  if (existsSync(out)) {
    console.error(`scratchwork eject: refusing to overwrite existing file: ${dest}`);
    process.exit(1);
  }

  const html = await loadShell();
  if (html == null) {
    console.error("scratchwork eject: could not load the default template (renderer build failed)");
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Wrote default template to ${dest}`);
}

function printHelp() {
  console.log(`scratchwork — CLI for Scratchwork projects

Usage:
  scratchwork dev [path] [--port N]   Serve a project with hot reload
  scratchwork create [path]           Scaffold a new project (example .md + components)
  scratchwork eject [file]            Write the default template (default: template.html)
  scratchwork --version               Print the version
  scratchwork --help                  Show this help

dev arguments:
  path           Directory to serve, or a file inside it to open.
                   dir            → root = dir,          open /
                   dir/file.html  → root = dir,          open /file
                   dir/file.md    → root = dir,          open /file
                 (default: current directory)

dev options:
  -p, --port N   Starting port to probe upward from (default: ${DEFAULT_PORT})
  -h, --help     Show this help

Serves a static site and hot-reloads on edits to .md / .html / .js / .css.
For a request /path/to/file the server resolves, in order:
  file.html | file/index.html   → served directly
  file.md   | file/index.md     → served through the nearest template.html or
                                  index.html renderer shell (or the CLI's
                                  built-in template), which fetches and renders
                                  the markdown.
Markdown edits re-render in place; everything else triggers a full reload.`);
}
