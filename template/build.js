/*
 * Build the Scratchwork universal renderer — a single, self-contained
 * index.html — in ONE step (no Vite, no HTML entry files).
 *
 *   1. esbuild bundles + minifies src/main.js (React, ReactDOM, Prism, htm, and
 *      the markdown parser/renderer) into one engine string, in memory.
 *   2. That string is wrapped in an index.html with three clearly-marked,
 *      hand-editable regions:
 *        THEME      — src/prose.css, formatted, in <style id="scratch-theme">
 *        PAGE SHELL — shell.js, formatted, in an editable <script>
 *        ENGINE     — the minified bundle, in a <script> at the bottom
 *
 * Outputs (both in dist/):
 *   • dist/index.html — the single-file renderer, served as a file.
 *   • dist/shell.js   — the same HTML as an importable JS module
 *                       (`export default "<html>"`), so the CLI can embed the
 *                       shell into its standalone binary via a static import.
 *
 * Runtime fetches: only the dynamic import() of ./components/*.js (and the page
 * .md itself). The engine — React included — is fully inlined. Content is never
 * rebuilt.
 *
 *   bun run build     # write dist/index.html + dist/shell.js
 *   bun run dev       # rebuild on change + preview the sample at :5180
 */
import { build as esbuild } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const r = (p) => join(root, p);
const DIST = r("dist");
const OUT_HTML = join(DIST, "index.html");
const OUT_SHELL = join(DIST, "shell.js");

// Everything — React, ReactDOM, Prism, htm, parser/renderer — is bundled and
// inlined into the engine <script>. No CDN, no import map, no runtime fetches
// for the engine itself (content .md files are still fetched at runtime).

// Guard against a literal </script> inside inlined JS terminating the tag early.
const safe = (js) => js.replace(/<\/script>/gi, "<\\/script>");

async function bundleEngine() {
  const result = await esbuild({
    entryPoints: [r("src/main.js")],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
  });
  return result.outputFiles[0].text.trim();
}

// Assemble the single-file renderer and return the HTML string. Pure — no
// writes — so callers can decide what to do with it (write to dist, embed, …).
export async function assemble() {
  const theme = readFileSync(r("src/prose.css"), "utf8").trimEnd();
  const shell = readFileSync(r("shell.js"), "utf8").trimEnd();
  const engine = await bundleEngine();

  const html = `<!doctype html>
<!--
  Scratchwork universal renderer — single, self-contained file.

  This file fetches a .md/.mdx alongside it and renders it in the browser.
  It is organized into three regions, each opened by a unique marker comment.

  ┌─ NOTE TO CODING AGENTS (Claude, Codex, etc.) ──────────────────────────┐
  │ This is one big file, but the parts you'll want to edit are small and   │
  │ near the top. The bottom region is a minified bundle that will flood    │
  │ your context if you read it. DO NOT read the whole file, and DO NOT     │
  │ page/scroll past the "DO NOT EDIT — BUNDLED ENGINE" marker.             │
  │                                                                         │
  │ Navigate by GREPPING for these stable markers (line numbers drift, so   │
  │ never rely on them):                                                    │
  │                                                                         │
  │   "EDITABLE — THEME"                                                    │
  │       Opens the <style id="scratch-theme"> block. Colors, fonts,        │
  │       spacing, prose typography, code highlighting. Edit freely. To     │
  │       edit CSS: grep for this marker to get its line N, then read from  │
  │       N up to the "EDITABLE — PAGE SHELL & COMPONENTS" marker only.     │
  │                                                                         │
  │   "EDITABLE — PAGE SHELL & COMPONENTS"                                  │
  │       Opens a <script type="module"> with the chrome wrapped around     │
  │       your markdown, plus any components referenced as <Tag/>. Authored │
  │       as JSX via html\`...\`. Edit freely. Read from this marker up to   │
  │       the "DO NOT EDIT — BUNDLED ENGINE" marker only.                   │
  │       To add a component referenced as <Tag/> from markdown, define it  │
  │       on window.SCRATCHWORK.components here (e.g.                        │
  │       window.SCRATCHWORK.components.Foo = (props) => html\`...\`). Prefer │
  │       this over a ./components/Foo.js sibling file — it keeps everything │
  │       in this one file, which is the whole point.                       │
  │                                                                         │
  │   "DO NOT EDIT — BUNDLED ENGINE"                                        │
  │       Everything from this marker to end-of-file is a minified bundle   │
  │       (React + ReactDOM + Prism + htm + the markdown parser/renderer)   │
  │       on a few enormous single lines. DO NOT READ IT — a single line    │
  │       can exceed your read budget. DO NOT EDIT IT by hand. To change    │
  │       the engine, edit ../template/src and run \`bun run build\`.        │
  └─────────────────────────────────────────────────────────────────────────┘
-->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title></title>

    <!-- ========================================================================
         EDITABLE — THEME
         Colors, fonts, spacing, prose typography, and the code (Prism) theme.
         ===================================================================== -->
    <style id="scratch-theme">
${theme}
    </style>
  </head>
  <body>
    <!-- ========================================================================
         EDITABLE — PAGE SHELL & COMPONENTS
         The page chrome wrapped around your rendered markdown, and any
         components your markdown references as <Tag/>. Authored as JSX via the
         \`html\` tagged template. \`React\`, \`ReactDOM\`, \`Prism\`, and \`html\`
         are available as globals (provided by the engine below).
         ===================================================================== -->
    <script type="module">
${safe(shell)}
    </script>

    <div id="root"></div>

    <!-- ========================================================================
         DO NOT EDIT — BUNDLED ENGINE
         Minified React + ReactDOM + Prism + htm + the markdown parser/renderer,
         all inlined. Rebuild from ../template/src with \`bun run build\`.
         ===================================================================== -->
    <script type="module">${safe(engine)}</script>
  </body>
</html>
`;

  return html;
}

// Build both dist artifacts (dist/index.html + dist/shell.js) and return the
// HTML. shell.js is the same HTML as a JS module — `export default "<html>"` —
// using JSON.stringify so it survives the backticks/${} in the minified engine.
export async function buildDist() {
  const html = await assemble();
  mkdirSync(DIST, { recursive: true });
  writeFileSync(OUT_HTML, html);
  writeFileSync(
    OUT_SHELL,
    `// AUTO-GENERATED by template/build.js — do not edit.\nexport default ${JSON.stringify(html)};\n`,
  );
  console.log(
    `Built template/dist/index.html + template/dist/shell.js (${(html.length / 1024).toFixed(1)} KB)`,
  );
  return html;
}

// Run as a script (`bun build.js [--watch]`); a no-op when imported.
if (import.meta.main) {
  await buildDist();

  // --watch: rebuild on source changes and preview the sample project — the
  // freshly built shell (dist/index.html) plus content from the sample docs
  // dir (index.md, components, logo).
  if (process.argv.includes("--watch")) {
    let timer;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => buildDist().catch((e) => console.error(e)), 50);
    };
    watch(r("src"), { recursive: true }, rebuild);
    watch(r("shell.js"), rebuild);

    const TPL = r("../docs");
    const port = Number(process.env.PORT) || 5180;
    Bun.serve({
      port,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const last = path.split("/").pop();
        // Routes (/, extensionless) → the built renderer; assets → the sample.
        if (path === "/" || !last.includes(".")) return new Response(Bun.file(OUT_HTML));
        return new Response(Bun.file(join(TPL, path)));
      },
    });
    console.log(`dev: http://localhost:${port}  (rebuilds on change)`);
  }
}
