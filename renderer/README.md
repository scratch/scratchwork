# Scratchwork renderer

Builds the **Scratchwork universal renderer** — a single-file `index.html`
(React, ReactDOM, and everything else inlined — no CDN) that renders any
Markdown/MDX file at runtime.

## The idea

The legacy Scratchwork tool rebuilt content → HTML every time the content changed.
This renderer flips that around:

- **Build once.** `build.js` (esbuild) bundles React + ReactDOM + Prism + htm +
  the engine into one minified blob (~196 KB) and assembles it into a single
  `index.html`. Nothing is fetched from a CDN — the artifact is fully
  self-contained and works offline.
- **Render forever.** That `index.html` fetches whatever `.md`/`.mdx` the URL
  points at, parses it in the browser, lazily loads any referenced components,
  and renders. **Content is never rebuilt** — edit the markdown, refresh.

So the pipeline ships the *renderer*, not the pages.

## Output structure (built for hand-editing)

The produced `index.html` is deliberately laid out in three regions so a coding
agent can edit the parts that matter while the engine stays out of the way:

1. **`<style id="scratchwork-theme">`** — the theme (`src/prose.css`), injected
   **formatted**. Design tokens, page chrome, prose typography, Prism theme.
2. **The editable `<script>`** — the page shell (`shell.js`), injected
   **formatted**. Defines `window.SCRATCHWORK.layout` and
   `window.SCRATCHWORK.components`, authored as JSX via the `html` tag (htm).
3. **The minified `<script>` at the bottom** — the bundled engine (React,
   ReactDOM, Prism, htm, parser/renderer — all inlined). Don't hand-edit; rebuild.

### Globals the engine exposes

Available to the editable region and to file-based components:
`window.React`, `window.ReactDOM`, `window.Prism`, and **`window.html`**
(`htm.bind(React.createElement)`). The editable region populates
`window.SCRATCHWORK.layout` (page chrome) and `window.SCRATCHWORK.components` (a
name → component map; consulted **before** lazy-loading `components/*.js`).

### Branding (not in the renderer)

The renderer embeds **no** images — no favicon, no logo, no Scratchwork-specific
components. Branding lives with the project content instead:

- The sample project (`docs/`) ships `scratchwork-logo.svg` (figure + wordmark)
  and uses it directly in `index.md`, plus a `MadeWithScratchwork` component
  under `docs/components/`.
- The `scratchwork dev` server serves the Scratchwork figure mark as the **default
  favicon** when a project ships none of its own (see `../cli/src/dev/server.ts`
  and `../cli/assets/figure.svg`).

## Build

One step. `build.js` esbuild-bundles the engine in memory, then assembles the
single-file artifact — formatted theme (`src/prose.css`) + formatted page shell
(`shell.js`) + minified engine — and writes:

- **`dist/index.html`** — the single-file renderer, served as a file.
- **`dist/shell.js`** — the same HTML as an importable JS module.
- **`../shared/src/site/default-renderer.generated.js`** — the generated module
  imported by the CLI so Bun embeds the renderer in standalone builds.

```bash
bun install
bun run build   # esbuild bundle + assemble -> dist/index.html + dist/shell.js
bun run dev     # same, then watch src/ + shell.js and preview the sample (:5180)
```

Override the dev port with `PORT=4321 bun run dev`. `dist/` is gitignored.

`build.js` also **exports** `assemble()` (returns the HTML string, no writes) and
`buildDist()` (writes `dist/` plus the shared generated module). The CLI's build
(`../cli/build.js`) imports `buildDist()` before compiling the standalone binary.
See the root `package.json`'s `build` script, which builds the renderer and the
CLI in one step.

## Files

**Bundled into the minified engine:**

| Layer | File(s) | Notes |
|-------|---------|-------|
| Entry / boot / routing | `src/main.js` | Fetches the page, mounts React, exposes `window.React` / `window.ReactDOM` / `window.Prism` / `window.html`, reads `window.SCRATCHWORK.layout` (with a minimal fallback) |
| Markdown + JSX parser | `src/parser.js` | Hand-rolled, dependency-free. Markdown + `<Component/>` tags + `className`/`style`. Not full MDX (no `{expressions}` / `import`) |
| React rendering | `src/render.js` | Blocks → React elements, headings, code blocks, tables |
| Component resolution | `src/components.js` | Lazy `import()` of `./components/*.js` (NOT bundled); inline-first resolution lives in `main.js` |
| Syntax highlighting | `src/highlight.js` | Prism + a curated language set |

**Injected formatted (NOT bundled), the editable regions:**

| Region | File | Notes |
|--------|------|-------|
| Theme | `src/prose.css` | Hand-written prose stylesheet + github-light Prism theme. **No Tailwind** |
| Page shell | `shell.js` | Default `window.SCRATCHWORK.layout` (chrome/footer) + inline components, in htm. The default lives here, not in the engine |

**Build-only:** `build.js` (esbuild bundle + assembly + dev server).

## Styling model

There is no CSS framework. Rendered markdown is styled by `prose.css` (scoped to
`.scratchwork-prose`). Components style themselves with inline `style` or a small
scoped `<style>` injected once (see `docs/components/Counter.js`). Raw HTML
in markdown can use inline `style="..."` — the renderer converts the string to a
React style object.

## Adding a syntax-highlighting language

Add a `import "prismjs/components/prism-<lang>"` line to `src/highlight.js`
(respecting Prism's dependency order), then `bun run build`.
