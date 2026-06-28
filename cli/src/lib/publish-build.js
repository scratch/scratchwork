/*
 * The publish transform — turn a source directory into the exact set of static
 * files a host should serve, such that the result renders byte-for-byte like
 * `scratchwork dev`.
 *
 * The one non-obvious step: `scratchwork dev` answers a markdown route by serving
 * a marked index.html renderer up the tree, else the built-in shell. The shell
 * then fetches the .md and renders it in the browser. A plain
 * static host can't do that lookup, so here we BAKE that shell out to a static
 * .html for every markdown route at publish time. After this step the site is
 * pure static files: .md/.js/.css/images served as-is, plus a baked .html per
 * markdown route — and a dumb static server reproduces dev exactly.
 *
 * Mirrors cli/src/commands/dev.ts's dev resolution (nearestShell,
 * sibling-html-wins, marked-index-html-as-shell-source). Zero dependencies
 * (node:fs + node:path).
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { isSafePath } from "../../../shared/resolve.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Extensions a static host should serve. Mirrors the server's content-type map.
// Anything else (source .ts, .env, etc.) is skipped — predictable and safe.
const PUBLISH_EXT = new Set([
  ".html", ".css", ".js", ".mjs", ".json", ".map",
  ".md", ".mdx", ".txt", ".xml", ".sh", ".wasm",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".otf",
  ".pdf", ".mp4", ".webm", ".mp3", ".wav",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", ".wrangler", ".scratchwork-data", ".cache",
]);

const MARKDOWN_RENDERER_MARKER =
  "<!-- scratchwork:markdown-renderer - tells Scratchwork this index.html renders Markdown routes. -->";

function isMarkedRenderer(data) {
  return dec.decode(data.subarray(0, 256)).startsWith(MARKDOWN_RENDERER_MARKER);
}

// Recursively list publishable files under `root`, as posix-relative paths,
// sorted for reproducible bundles.
function listFiles(root) {
  const out = [];
  function walk(absDir, relDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue; // dotfiles & dotdirs
      const abs = join(absDir, ent.name);
      const rel = relDir ? relDir + "/" + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (PUBLISH_EXT.has(extname(ent.name).toLowerCase())) out.push(rel);
      }
      // symlinks and other special files are skipped
    }
  }
  walk(root, "");
  return out;
}

// Walk up from `absDir` to `root` for the nearest marked index.html markdown
// renderer; fall back to the built-in shell.
// Returns the shell as bytes (so it can be written out as a static .html).
function makeNearestShell(root, bakedShell) {
  const baked = enc.encode(bakedShell);
  return function nearestShell(absDir) {
    let d = absDir;
    while (true) {
      const cand = join(d, "index.html");
      if (existsSync(cand) && statSync(cand).isFile()) {
        const data = new Uint8Array(readFileSync(cand));
        if (isMarkedRenderer(data)) return data;
      }
      if (d === root) break;
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return baked;
  };
}

// Map a markdown relative path to the .html route a static host should serve.
//   index.md       -> index.html
//   a/index.mdx    -> a/index.html
//   guide.md       -> guide.html
//   a/b/page.md    -> a/b/page.html
function htmlRouteFor(relMd) {
  const ext = extname(relMd);
  const dir = dirname(relMd);
  const base = basename(relMd, ext);
  const name = base === "index" ? "index.html" : base + ".html";
  return dir === "." ? name : dir + "/" + name;
}

/*
 * Build the publishable file set.
 *
 *   root        absolute source directory
 *   only        optional posix-relative single file to publish AS the site index
 *   bakedShell  the built-in renderer shell (string), used when a markdown route
 *               has no marked index.html ancestor
 *
 * Returns { files: [{ path, data: Uint8Array }], stats, skipped }.
 */
export function buildPublishFiles({ root, only, bakedShell }) {
  const nearestShell = makeNearestShell(root, bakedShell);
  const files = new Map(); // posix path -> Uint8Array (last write wins, dedup)

  // Single-file mode: the chosen file becomes the site's index page.
  if (only) {
    const abs = join(root, only);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`no such file: ${only}`);
    }
    const ext = extname(only).toLowerCase();
    const data = new Uint8Array(readFileSync(abs));
    if (ext === ".md") {
      files.set("index.md", data);
      files.set("index.html", nearestShell(dirname(abs)));
    } else if (ext === ".html") {
      files.set("index.html", data);
    } else {
      files.set(basename(only), data);
    }
    return finalize(files);
  }

  // Directory mode.
  const list = listFiles(root);
  const sourcePaths = new Set();

  // 1. Copy every publishable file as-is (except marked index.html renderers).
  for (const rel of list) {
    const data = new Uint8Array(readFileSync(join(root, rel)));
    if (basename(rel) === "index.html" && isMarkedRenderer(data)) continue;
    sourcePaths.add(rel);
    files.set(rel, data);
  }

  // 2. Bake a renderer shell for each markdown route that lacks a sibling .html.
  //    Only `.md` is a route: the renderer shell fetches `.md` (never `.mdx`),
  //    exactly like `scratchwork dev`. `.mdx` files still upload (served raw),
  //    matching dev's raw file serving — they just aren't page routes.
  for (const rel of list) {
    if (extname(rel).toLowerCase() !== ".md") continue;
    const htmlPath = htmlRouteFor(rel);
    if (sourcePaths.has(htmlPath)) continue; // an authored .html wins, like dev
    if (files.has(htmlPath)) continue; // already baked (e.g. index.md + index.mdx)
    files.set(htmlPath, nearestShell(join(root, dirname(rel))));
  }

  return finalize(files);
}

function finalize(files) {
  const out = [];
  let totalBytes = 0;
  for (const [path, data] of files) {
    // Validate here too (not just server-side) so an unpublishable path fails
    // fast, before compressing and uploading.
    if (!isSafePath(path)) {
      throw new Error(`unsafe file path: "${path}" (paths cannot contain "..")`);
    }
    out.push({ path, data });
    totalBytes += data.length;
  }
  return { files: out, stats: { fileCount: out.length, totalBytes } };
}
