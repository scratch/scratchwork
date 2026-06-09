/*
 * Rendering: turns parsed blocks (from parser.js) into React elements.
 *
 * Styling note: there are NO utility (Tailwind) classes here. Markdown output
 * is styled by prose.css via the `.scratchwork-prose` container; a handful of
 * semantic class names (scratchwork-heading, scratchwork-codeblock, scratchwork-copy,
 * scratchwork-table-wrap, heading-anchor) are also defined there.
 */
import React from "react";
import {
  scanElement,
  parseJSXAttrs,
  parseBlocks,
  dedent,
  splitTableRow,
  slugify,
  plainText,
} from "./parser.js";
import { highlight, resolveLang } from "./highlight.js";

const e = React.createElement;
const { useState, useRef } = React;

// Table cells carry a per-column text-align from the markdown separator row.
const alignStyle = (align) => (align ? { textAlign: align } : undefined);

/* ---------- Inline markdown ---------- */

const INLINE_PATTERNS = [
  { re: /`([^`]+)`/, render: (m) => e("code", null, m[1]) },
  { re: /\*\*([^*\n]+?)\*\*/, render: (m, ctx) => e("strong", null, ...parseInline(m[1], ctx)) },
  { re: /(?<![*\w])\*([^*\n]+?)\*(?![*\w])/, render: (m, ctx) => e("em", null, ...parseInline(m[1], ctx)) },
  { re: /(?<![\w_])_([^_\n]+?)_(?![\w_])/, render: (m, ctx) => e("em", null, ...parseInline(m[1], ctx)) },
  { re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/, render: (m) => e("img", { src: m[2], alt: m[1], title: m[3] }) },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/,
    render: (m, ctx) => {
      const href = m[2];
      const isExternal = /^https?:\/\//.test(href);
      const props = { href, title: m[3] };
      if (isExternal) { props.target = "_blank"; props.rel = "noopener noreferrer"; }
      return e("a", props, ...parseInline(m[1], ctx));
    },
  },
];

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
    for (let j = 0; j < rem.length; j++) {
      if (rem[j] === "<" && /[A-Za-z]/.test(rem[j + 1] || "")) {
        const parsed = scanElement(rem, j);
        if (parsed) { elemIdx = j; elemNode = parsed; break; }
      }
    }

    // earliest regex pattern
    let bestIdx = -1;
    let bestLen = 0;
    let bestMatch = null;
    let bestRender = null;
    for (const { re, render } of INLINE_PATTERNS) {
      const m = rem.match(re);
      if (m && m.index !== undefined) {
        if (bestIdx === -1 || m.index < bestIdx) {
          bestIdx = m.index;
          bestLen = m[0].length;
          bestMatch = m;
          bestRender = render;
        }
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

/* ---------- Elements (components + raw HTML) ---------- */

function renderElementNode(node, ctx, opts = {}) {
  const props = parseJSXAttrs(node.attrs);
  const key = opts.key;
  const isComponent = /^[A-Z]/.test(node.name);

  let children = null;
  if (!node.selfClosing) {
    const multiline = /\n/.test(node.raw || node.inner);
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
    const el = children == null ? e(Comp, { ...props }) : e(Comp, { ...props }, ...children);
    // Self-closing block components opt out of prose typography (scratchwork behavior).
    if (node.selfClosing && !opts.inline) {
      return e("div", { key, className: "not-prose" }, el);
    }
    return key != null ? React.cloneElement(el, { key }) : el;
  }

  const elProps = { ...props, key };
  // Raw HTML elements may carry an inline `style="..."` string (the natural way
  // to style markup in markdown now that there's no Tailwind). React needs a
  // style OBJECT, so convert it here.
  if (typeof elProps.style === "string") elProps.style = styleToObject(elProps.style);
  return children == null ? e(node.name, elProps) : e(node.name, elProps, ...children);
}

// "color:red; font-size:1rem" -> { color: "red", fontSize: "1rem" }
export function styleToObject(str) {
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

function Heading({ level, text, ctx }) {
  const Tag = "h" + level;
  const kids = parseInline(text, ctx);
  if (level === 2 || level === 3) {
    const label = plainText(text);
    const id = slugify(label);
    return e(
      Tag,
      { id, className: "scratchwork-heading" },
      e("a", { href: "#" + id, className: "heading-anchor", "aria-label": "Link to " + label }, "#"),
      ...kids,
    );
  }
  return e(Tag, null, ...kids);
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  const onCopy = async () => {
    const t = ref.current ? ref.current.textContent || "" : "";
    try { await navigator.clipboard.writeText(t); } catch (err) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const resolved = resolveLang(lang);
  const html = highlight(code, lang);
  let pre;
  if (html != null) {
    const langClass = "language-" + resolved;
    pre = e("pre", {
      ref,
      className: langClass,
      tabIndex: 0,
    }, e("code", {
      className: langClass,
      dangerouslySetInnerHTML: { __html: html },
    }));
  } else {
    pre = e("pre", { ref }, e("code", { className: lang ? "language-" + lang : undefined }, code + "\n"));
  }

  return e(
    "div",
    { className: "scratchwork-codeblock" },
    e("button", { className: "scratchwork-copy", "aria-label": "Copy code", onClick: onCopy }, copied ? "Copied!" : "Copy"),
    pre,
  );
}

/* ---------- Block renderer ---------- */

function renderBlock(block, key, ctx) {
  const k = "b" + key;
  switch (block.type) {
    case "heading":
      return e(Heading, { key: k, level: block.level, text: block.text, ctx });
    case "p":
      return e("p", { key: k }, ...parseInline(block.text.replace(/\n/g, " ").replace(/\s+$/, ""), ctx));
    case "ul":
    case "ol": {
      const Tag = block.type;
      return e(Tag, { key: k }, block.items.map((item, j) => e("li", { key: "li" + j }, ...parseInline(item, ctx))));
    }
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

export function renderBlocks(blocks, ctx) {
  return blocks.map((b, i) => renderBlock(b, i, ctx));
}
