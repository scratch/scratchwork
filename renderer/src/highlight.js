/*
 * Syntax highlighting via Prism. The core `prismjs` build already registers
 * markup (html), css, clike, and javascript. We add a curated set of common
 * languages below, in dependency order (e.g. tsx needs jsx + typescript).
 *
 * Prism is bundled into the engine. The token colors live in prose.css (a
 * hand-tuned github-light theme) so the highlighted output matches the rest of
 * the page.
 */
import Prism from "prismjs";

// Don't auto-highlight the whole document; we highlight on demand per block.
Prism.manual = true;

// Include the extension so these package subpaths also resolve in Node's ESM
// loader (the V8 regression check imports the renderer sources directly).
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";

// A few friendly aliases so common fence labels resolve.
const ALIASES = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  md: "markdown",
  mdx: "markdown",
};

// Map a fence label to Prism's canonical language name ("js" -> "javascript").
function resolveLang(lang) {
  if (!lang) return null;
  const key = lang.toLowerCase();
  return ALIASES[key] || key;
}

// Highlight a code block. Returns { html, lang } — highlighted markup plus
// the resolved language name (for the language-* class) — or null when the
// language is unknown (caller falls back to a plain, unhighlighted <code>).
export function highlight(code, lang) {
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  const grammar = Prism.languages[resolved];
  if (!grammar) return null;
  return { html: Prism.highlight(code, grammar, resolved), lang: resolved };
}

export default Prism;
