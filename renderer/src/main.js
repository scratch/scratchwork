/*
 * Scratchwork universal renderer — entry point.
 *
 * This bundle (React + ReactDOM + Prism + htm + the engine) is built ONCE and
 * inlined, minified, at the bottom of a single index.html. The theme (CSS) and
 * the page shell live in separate, hand-editable regions above it (assembled by
 * build.js), NOT in this bundle. At runtime it
 * fetches whatever .md/.mdx file the URL points at, parses it in the browser,
 * lazily loads any referenced components, and renders. Content is never rebuilt.
 *
 * React/ReactDOM/Prism/html are re-exposed on `window` so the page's editable
 * region (the page shell + inline components) and any runtime-loaded component
 * files (./components/*.js) can use them without being part of this bundle.
 */
import React from "react";
import * as ReactDOM from "react-dom/client";
import htm from "htm";
import Prism from "./highlight.js";
import { parseFrontmatter, parseBlocks, collectLinkDefs } from "./parser.js";
import { loadComponent, collectComponentNames } from "./components.js";
import { renderBlocks } from "./render.js";

const e = React.createElement;
const html = htm.bind(React.createElement);

// Expose for the editable region + runtime components. `window.ReactDOM` is
// the react-dom/client namespace (createRoot/hydrateRoot). `window.html` is
// the htm tag bound to React.createElement, so editable code can author JSX
// as html`...`.
window.React = React;
window.ReactDOM = ReactDOM;
window.Prism = Prism;
window.html = html;

// The editable region (above this bundle in the page) assigns the page chrome
// and inline components onto window.SCRATCHWORK. Make sure the shape exists even if
// that region was removed.
window.SCRATCHWORK = window.SCRATCHWORK || {};
window.SCRATCHWORK.components = window.SCRATCHWORK.components || {};

// Re-render the current page in place (re-fetches its .md, no full reload).
// Used by `scratchwork dev` for hot-reloading content edits; harmless otherwise.
window.SCRATCHWORK.refresh = () => renderPage();

// Minimal fallback chrome, used only if the editable region didn't define a
// layout. Renders the markdown inside `.scratchwork-prose` with no footer.
function FallbackLayout({ children }) {
  return e(
    "div",
    { className: "scratchwork-page" },
    e("div", { className: "scratchwork-prose" }, ...children),
  );
}

// The directory the *current markdown* lives in — content and referenced
// components resolve against this, and it is updated on every render. The served
// HTML shell may be an ancestor of the markdown (e.g. /index.html rendering
// /docs/guide.md), so this cannot be derived from document.baseURI; it comes
// from the resolved markdown URL. The initial value is only a fallback.
let contentBase = new URL(".", document.baseURI).href;

let root = null;

// The React root, mounted on #root (created if the page lacks one).
function ensureRoot() {
  if (root) return root;
  let container = document.getElementById("root");
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
  }
  root = ReactDOM.createRoot(container);
  return root;
}

// Apply frontmatter to the document: title, lang, and the usual
// description/keywords/author/og:* meta tags (created if absent).
function applyMeta(meta) {
  if (meta.title) document.title = meta.title;
  if (meta.lang) document.documentElement.lang = meta.lang;
  const setMeta = (name, content, attr = "name") => {
    if (!content) return;
    let el = document.head.querySelector(`meta[${attr}="${name}"]`);
    if (!el) { el = document.createElement("meta"); el.setAttribute(attr, name); document.head.appendChild(el); }
    el.setAttribute("content", content);
  };
  setMeta("description", meta.description);
  setMeta("keywords", meta.keywords);
  setMeta("author", meta.author);
  setMeta("og:title", meta.title, "property");
  setMeta("og:description", meta.description, "property");
}

// After React commits, jump to the URL's #fragment heading (if any) or the top.
function scrollAfterRender() {
  requestAnimationFrame(() => {
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

// Fetch the markdown the current URL maps to, parse it, resolve its
// components, and render it into the page layout.
async function renderPage() {
  // Fetch the first markdown candidate the current URL maps to. The shell is
  // reached for an extensionless route; the actual file is <route>.md or
  // <route>/index.md, resolved absolutely from the origin (not relative to the
  // shell, which may live higher up the tree).
  let res = null;
  let mdUrl = null;
  for (const cand of mdCandidates(location.pathname)) {
    const url = new URL(cand, location.origin).href;
    try {
      // Same-origin fetch with default credentials: private projects are authenticated by
      // a path-scoped cookie on the content host, which must ride along on every request.
      const r = await fetch(url);
      if (r.ok) { res = r; mdUrl = url; break; }
    } catch (err) {
      /* try the next candidate */
    }
  }
  const Layout = window.SCRATCHWORK.layout || FallbackLayout;
  if (!res) {
    console.error(`[scratchwork] no markdown for ${location.pathname}`);
    ensureRoot().render(e(Layout, {}, e("p", { key: "nf" }, `No markdown found for ${location.pathname}.`)));
    return;
  }
  // Content + referenced components resolve against the markdown's own directory.
  contentBase = new URL(".", mdUrl).href;
  const md = await res.text();
  const { meta, body } = parseFrontmatter(md);
  applyMeta(meta);

  // Resolve referenced components inline-first: use a definition from the
  // editable region (window.SCRATCHWORK.components) if present, otherwise lazy-load
  // it from ./components/<Name>.js.
  const names = collectComponentNames(body);
  const inline = window.SCRATCHWORK.components;
  const components = {};
  await Promise.all(names.map(async (n) => {
    if (inline[n]) { components[n] = inline[n]; return; }
    const C = await loadComponent(n, contentBase);
    if (C) components[n] = C;
  }));

  const blocks = parseBlocks(body);
  const ctx = { components, baseUrl: contentBase, linkDefs: collectLinkDefs(blocks) };
  const content = renderBlocks(blocks, ctx);

  ensureRoot().render(e(Layout, { author: meta.author }, ...content));
  scrollAfterRender();
}

// From the current URL path, the ordered absolute .md candidates to try. The
// dev server / static host rewrites an extensionless `.md` route to the nearest
// renderer shell; the shell then loads the real file from here. "/foo" → try
// "/foo.md" then "/foo/index.md"; "/" or "/foo/" → that directory's "index.md".
function mdCandidates(pathname) {
  let p = pathname;
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  else if (p.endsWith(".html")) p = p.slice(0, -".html".length);
  if (p === "") p = "/";
  if (p.endsWith("/")) return [p + "index.md"];
  return [p + ".md", p + "/index.md"];
}

// Intercept plain left-clicks on relative .md links and route them in-page
// (pushState + re-render) instead of navigating to the raw markdown file.
// Modified clicks (new tab), external URLs, #fragments, and non-.md links
// keep the browser's default behavior.
document.addEventListener("click", (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = ev.target.closest("a");
  if (!a || (a.target && a.target !== "_self")) return;
  const href = a.getAttribute("href");
  if (!href || /^https?:\/\//.test(href) || href.startsWith("#")) return;
  // Resolve the link against the current markdown's directory; ?query and
  // #fragment ride along ("guide.md#setup" routes to "/guide#setup").
  const abs = new URL(href, contentBase);
  if (!abs.pathname.endsWith(".md")) return;
  ev.preventDefault();
  history.pushState(null, "", abs.pathname.replace(/\.md$/, "") + abs.search + abs.hash);
  renderPage();
});

window.addEventListener("popstate", () => renderPage());

renderPage();
