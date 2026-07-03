/*
 * Rendering: turns parsed blocks (from parser.js) into React elements.
 *
 * The rendering context (ctx) threads through every function here:
 *   ctx.components — name -> React component map for <Tag/> references
 *   ctx.baseUrl    — the markdown file's directory; relative image srcs
 *                    resolve against it (optional)
 *   ctx.linkDefs   — { ref: { href, title } } for [text][ref] links (optional)
 *   ctx.slugCounts — heading-id dedup state, created lazily per render
 *
 * Styling note: there are NO utility (Tailwind) classes here. Markdown output
 * is styled by prose.css via the `.scratchwork-prose` container; a handful of
 * semantic class names (scratchwork-heading, scratchwork-codeblock,
 * scratchwork-copy, scratchwork-table-wrap, scratchwork-missing,
 * heading-anchor, task-list, task-list-item) are also defined there.
 */
import React from "react";
import {
  scanElement,
  parseJSXAttrs,
  parseBlocks,
  dedent,
  slugify,
  plainText,
} from "./parser.js";
import { highlight } from "./highlight.js";

const e = React.createElement;
const { useState, useRef, useEffect } = React;

// Table cells carry a per-column text-align from the markdown separator row.
const alignStyle = (align) => (align ? { textAlign: align } : undefined);

// Resolve a relative image src against the markdown file's directory, so
// images travel with their content ("./pic.png" next to guide.md always
// works). Absolute paths, full URLs, and data: URIs pass through untouched.
function resolveSrc(src, ctx) {
  if (!src || !ctx.baseUrl || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(src)) return src;
  try { return new URL(src, ctx.baseUrl).href; } catch { return src; }
}

// Standard <a> props for a markdown link; external links open in a new tab.
function linkProps(href, title) {
  const props = { href, title };
  if (/^https?:\/\//.test(href)) { props.target = "_blank"; props.rel = "noopener noreferrer"; }
  return props;
}

// Look up a [text][ref] / [ref] reference-link definition (case-insensitive).
const linkDef = (ctx, ref) => (ctx.linkDefs || {})[ref.toLowerCase()];

/* ---------- Inline markdown ---------- */

// Shared regex fragments: a link/image destination (parens allowed one level
// deep, so wikipedia.org/wiki/Bracket_(disambiguation) survives), a title,
// and a link label (escapes and complete inline images allowed, so the badge
// pattern [![alt](img)](href) is just a link whose label is an image).
const DEST = /((?:[^()\s]|\([^()\s]*\))+)/.source;
const TITLE = /(?:\s+"([^"]*)")?/.source;
const LABEL = /((?:\\.|!\[[^\]]*\]\([^()\s]*\)|[^[\]\\])+)/.source;

// When a [ref] has no definition, render the brackets literally but still
// parse the inline markdown between them.
const bracketed = (inner, ctx, trailing = "") =>
  e(React.Fragment, null, "[", ...parseInline(inner, ctx), "]" + trailing);

// Inline syntax, tried in order at each position; when two patterns match at
// the same index the EARLIER entry wins, so order encodes priority (code
// spans protect their contents from everything below, escapes beat emphasis).
//
// ReDoS note: in every emphasis pattern the alternatives are DISJOINT — the
// negated classes exclude "\\" so they can never trade characters with the
// `\\.` escape alternative. Overlapping alternatives backtrack exponentially
// in V8 on inputs like `**` + `\a`.repeat(30) and freeze the tab.
const INLINE_PATTERNS = [
  // `code` / ``code with ` inside`` — backtick runs of any length; one space
  // is stripped from each end when both are present (CommonMark rule).
  {
    re: /(`+)((?:(?!\1)[\s\S])+?)\1(?!`)/,
    render: (m) => {
      let text = m[2];
      if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
      return e("code", null, text);
    },
  },
  // Backslash escapes: \* renders a literal * instead of emphasis.
  { re: /\\([\\`*_{}[\]()#+\-.!|~<>"'])/, render: (m) => m[1] },
  // <!-- inline comments --> render nothing.
  { re: /<!--[\s\S]*?-->/, render: () => null },
  // <https://…> and <user@host> autolinks.
  { re: /<(https?:\/\/[^<>\s]+)>/, render: (m) => e("a", linkProps(m[1]), m[1]) },
  { re: /<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/, render: (m) => e("a", { href: "mailto:" + m[1] }, m[1]) },
  // ***bold italic***
  { re: /\*\*\*((?:\\.|[^\\*\n])+?)\*\*\*/, render: (m, ctx) => e("strong", null, e("em", null, ...parseInline(m[1], ctx))) },
  // **bold** / __bold__ (may contain *italic*)
  { re: /\*\*((?:\\.|[^\\*\n]|\*(?!\*))+?)\*\*/, render: (m, ctx) => e("strong", null, ...parseInline(m[1], ctx)) },
  { re: /(?<![\w_])__((?:\\.|[^\\_\n]|_(?!_))+?)__(?![\w_])/, render: (m, ctx) => e("strong", null, ...parseInline(m[1], ctx)) },
  // *italic* / _italic_ (may contain **bold**; never mid-word: snake_case stays)
  { re: /(?<![*\w])\*((?:\\.|[^\\*\n]|\*\*)+?)\*(?![*\w])/, render: (m, ctx) => e("em", null, ...parseInline(m[1], ctx)) },
  { re: /(?<![\w_])_((?:\\.|[^\\_\n]|__)+?)_(?![\w_])/, render: (m, ctx) => e("em", null, ...parseInline(m[1], ctx)) },
  // ~~strikethrough~~
  { re: /~~((?:\\.|[^\\~\n])+?)~~/, render: (m, ctx) => e("del", null, ...parseInline(m[1], ctx)) },
  // ![alt](src "title")
  { re: new RegExp(`!\\[([^\\]]*)\\]\\(${DEST}${TITLE}\\)`), render: (m, ctx) => e("img", { src: resolveSrc(m[2], ctx), alt: m[1], title: m[3] }) },
  // ![alt][ref] reference image.
  {
    re: /!\[([^\]]*)\]\[([^\]]*)\]/,
    render: (m, ctx) => {
      const def = linkDef(ctx, m[2] || m[1]);
      return def ? e("img", { src: resolveSrc(def.href, ctx), alt: m[1], title: def.title }) : m[0];
    },
  },
  // [label](href "title") — the label may itself contain an image (badges).
  { re: new RegExp(`\\[${LABEL}\\]\\(${DEST}${TITLE}\\)`), render: (m, ctx) => e("a", linkProps(m[2], m[3]), ...parseInline(m[1], ctx)) },
  // [text][ref] / [text][] reference links (definitions collected by main.js).
  {
    re: new RegExp(`\\[${LABEL}\\]\\[([^\\]]*)\\]`),
    render: (m, ctx) => {
      const def = linkDef(ctx, m[2] || m[1]);
      return def ? e("a", linkProps(def.href, def.title), ...parseInline(m[1], ctx)) : bracketed(m[1], ctx, `[${m[2]}]`);
    },
  },
  // [ref] shortcut reference link; without a definition the brackets stay
  // literal but their contents still render as markdown.
  {
    re: /\[([^\]]+)\](?!\()/,
    render: (m, ctx) => {
      const def = linkDef(ctx, m[1]);
      return def ? e("a", linkProps(def.href, def.title), ...parseInline(m[1], ctx)) : bracketed(m[1], ctx);
    },
  },
  // Bare URLs (GFM autolink): conservative about trailing punctuation.
  { re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, render: (m) => e("a", linkProps(m[0]), m[0]) },
];

// Parse inline markdown (emphasis, code, links, <Elements/>, …) into an array
// of strings and React elements. At each step the earliest match wins —
// either an embedded JSX/HTML element or the earliest INLINE_PATTERNS hit.
function parseInline(text, ctx) {
  if (text == null) return [];
  const out = [];
  let rem = text;
  let key = 0;
  const push = (val) => {
    if (val == null) return;
    if (typeof val === "string") { out.push(val); return; }
    out.push(React.cloneElement(val, { key: "i" + key++ }));
  };

  while (rem.length > 0) {
    // earliest element start that parses
    let elemIdx = -1;
    let elemNode = null;
    for (let j = rem.indexOf("<"); j !== -1; j = rem.indexOf("<", j + 1)) {
      if (/[A-Za-z]/.test(rem[j + 1] || "")) {
        const parsed = scanElement(rem, j);
        if (parsed) { elemIdx = j; elemNode = parsed; break; }
      }
    }

    // earliest regex pattern (ties broken by INLINE_PATTERNS order)
    let bestIdx = -1;
    let bestLen = 0;
    let bestMatch = null;
    let bestRender = null;
    for (const { re, render } of INLINE_PATTERNS) {
      const m = rem.match(re);
      if (m && (bestIdx === -1 || m.index < bestIdx)) {
        bestIdx = m.index;
        bestLen = m[0].length;
        bestMatch = m;
        bestRender = render;
      }
    }

    if (elemNode && (bestIdx === -1 || elemIdx <= bestIdx)) {
      if (elemIdx > 0) push(rem.slice(0, elemIdx));
      push(renderElementNode(elemNode, ctx, { inline: true }));
      rem = rem.slice(elemNode.end);
      continue;
    }

    if (bestMatch) {
      if (bestIdx > 0) push(rem.slice(0, bestIdx));
      push(bestRender(bestMatch, ctx));
      rem = rem.slice(bestIdx + bestLen);
      continue;
    }

    push(rem);
    break;
  }
  return out;
}

// Render paragraph-ish text: hard line breaks (trailing double space or
// backslash-newline) become <br/>; remaining newlines soften to spaces.
// Break markers inside `code spans` don't count (CommonMark), so the text is
// split against a copy with code spans masked out.
function parseInlineWithBreaks(text, ctx) {
  text = text.replace(/\s+$/, "");
  const masked = text.replace(/(`+)(?:(?!\1)[\s\S])+?\1(?!`)/g, (m) => "x".repeat(m.length));
  const out = [];
  let start = 0;
  let n = 0;
  const emit = (end) => {
    if (n > 0) out.push(e("br", { key: "br" + n }));
    out.push(...parseInline(text.slice(start, end).replace(/\n/g, " "), ctx));
    n++;
  };
  const breakRe = / {2,}\n|\\\n/g;
  let m;
  while ((m = breakRe.exec(masked)) !== null) {
    emit(m.index);
    start = m.index + m[0].length;
  }
  emit(text.length);
  return out;
}

/* ---------- Elements (components + raw HTML) ---------- */

// Render one scanned element (from scanElement): a capitalized name becomes a
// component from ctx.components (or a red placeholder when missing); anything
// else becomes the raw HTML tag. Children: single-line inner text parses as
// inline markdown; multi-line inner text re-parses as full blocks.
function renderElementNode(node, ctx, opts = {}) {
  const props = parseJSXAttrs(node.attrs);
  const key = opts.key;
  const isComponent = /^[A-Z]/.test(node.name);

  let children = null;
  if (!node.selfClosing) {
    const multiline = /\n/.test(node.inner);
    if (opts.inline || !multiline) {
      children = parseInline(node.inner, ctx);
    } else {
      children = renderBlocks(parseBlocks(dedent(node.inner)), ctx);
    }
  }

  if (isComponent) {
    const Comp = ctx.components[node.name];
    if (!Comp) {
      return e("span", { key, className: "scratchwork-missing" }, `<${node.name} />`);
    }
    // Self-closing block components opt out of prose typography (scratchwork behavior).
    if (node.selfClosing && !opts.inline) {
      return e("div", { key, className: "not-prose" }, e(Comp, { ...props }));
    }
    return children == null ? e(Comp, { ...props, key }) : e(Comp, { ...props, key }, ...children);
  }

  const elProps = { ...props, key };
  // Raw HTML elements may carry an inline `style="..."` string (the natural way
  // to style markup in markdown now that there's no Tailwind). React needs a
  // style OBJECT, so convert it here.
  if (typeof elProps.style === "string") elProps.style = styleToObject(elProps.style);
  // Relative asset paths (<img src>, <video poster>, <source src>, …) travel
  // with the markdown file, like markdown image syntax does.
  for (const attr of ["src", "poster"]) {
    if (typeof elProps[attr] === "string") elProps[attr] = resolveSrc(elProps[attr], ctx);
  }
  return children == null ? e(node.name, elProps) : e(node.name, elProps, ...children);
}

// "color:red; font-size:1rem" -> { color: "red", fontSize: "1rem" }
// (custom properties like --x pass through unchanged).
function styleToObject(str) {
  const obj = {};
  for (const decl of str.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim();
    if (!prop) continue;
    const val = decl.slice(idx + 1).trim();
    const camel = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    obj[camel] = val;
  }
  return obj;
}

/* ---------- Headings & code blocks ---------- */

// Anchor id for a heading, deduped across the page ("setup", "setup-2", …).
function headingId(text, ctx) {
  const base = slugify(text) || "section";
  const counts = (ctx.slugCounts = ctx.slugCounts || new Map());
  const n = (counts.get(base) || 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

// Every heading gets a linkable id; h2/h3 also get the hover "#" anchor.
function heading(level, text, key, ctx) {
  const Tag = "h" + level;
  const kids = parseInline(text, ctx);
  const id = headingId(text, ctx);
  if (level === 2 || level === 3) {
    return e(
      Tag,
      { key, id, className: "scratchwork-heading" },
      e("a", { href: "#" + id, className: "heading-anchor", "aria-label": "Link to " + plainText(text) }, "#"),
      ...kids,
    );
  }
  return e(Tag, { key, id }, ...kids);
}

// A fenced code block: Prism-highlighted <pre> (when the language is known)
// with a hover "Copy" button.
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    const t = ref.current ? ref.current.textContent || "" : "";
    try { await navigator.clipboard.writeText(t); } catch (err) {}
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const hl = highlight(code, lang);
  let pre;
  if (hl) {
    const langClass = "language-" + hl.lang;
    pre = e("pre", {
      ref,
      className: langClass,
      tabIndex: 0,
    }, e("code", {
      className: langClass,
      dangerouslySetInnerHTML: { __html: hl.html },
    }));
  } else {
    pre = e("pre", { ref, tabIndex: 0 }, e("code", { className: lang ? "language-" + lang : undefined }, code + "\n"));
  }

  return e(
    "div",
    { className: "scratchwork-codeblock" },
    e("button", { className: "scratchwork-copy", "aria-label": "Copy code", onClick: onCopy }, copied ? "Copied!" : "Copy"),
    pre,
  );
}

/* ---------- Lists ---------- */

// One <li>: task items get a checkbox, nested lists/code render below the text.
function listItem(item, key, ctx) {
  const kids = [];
  if (item.checked !== undefined) {
    kids.push(e("input", { key: "cb", type: "checkbox", defaultChecked: item.checked, disabled: true }));
  }
  kids.push(...parseInline(item.text.replace(/\n/g, " "), ctx));
  item.children.forEach((child, j) => kids.push(renderBlock(child, key + "c" + j, ctx)));
  const cls = item.checked !== undefined ? "task-list-item" : undefined;
  return e("li", { key, className: cls }, ...kids);
}

// <ul>/<ol> for a list block, with GFM task-list styling and start numbers.
function list(block, key, ctx) {
  const attrs = { key };
  if (block.type === "ol" && block.start) attrs.start = block.start;
  if (block.items.some((it) => it.checked !== undefined)) attrs.className = "task-list";
  return e(block.type, attrs, block.items.map((item, j) => listItem(item, "li" + j, ctx)));
}

/* ---------- Block renderer ---------- */

// Render a single block descriptor (see parseBlocks) to a React element.
function renderBlock(block, key, ctx) {
  const k = "b" + key;
  switch (block.type) {
    case "heading":
      return heading(block.level, block.text, k, ctx);
    case "p":
      return e("p", { key: k }, ...parseInlineWithBreaks(block.text, ctx));
    case "ul":
    case "ol":
      return list(block, k, ctx);
    case "code":
      return e(CodeBlock, { key: k, lang: block.lang, code: block.code });
    case "hr":
      return e("hr", { key: k });
    case "blockquote":
      return e("blockquote", { key: k }, ...parseBlocks(block.text).map((b, j) => renderBlock(b, k + "-" + j, ctx)));
    case "table":
      return e(
        "div",
        { key: k, className: "scratchwork-table-wrap" },
        e(
          "table",
          null,
          e("thead", null, e("tr", null, block.headers.map((cell, j) => e("th", { key: "th" + j, style: alignStyle(block.align[j]) }, ...parseInline(cell, ctx))))),
          e("tbody", null, block.rows.map((row, r) => e("tr", { key: "tr" + r }, block.headers.map((_, c) => e("td", { key: "td" + c, style: alignStyle(block.align[c]) }, ...parseInline(row[c] || "", ctx)))))),
        ),
      );
    case "jsx": {
      const node = scanElement(block.src, 0);
      if (!node) return null;
      return renderElementNode(node, ctx, { key: k });
    }
  }
  return null;
}

// Render a parsed block list to an array of React elements. ctx must carry
// { components }; see the file header for the full shape.
export function renderBlocks(blocks, ctx) {
  return blocks.map((b, i) => renderBlock(b, i, ctx));
}
