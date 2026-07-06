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

import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";

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
