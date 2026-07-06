/*
 * Markdown + JSX parser.
 *
 * A small, dependency-free, hand-rolled parser. It produces a tree of plain
 * block descriptors (see parseBlocks) plus helpers for scanning JSX/HTML
 * element tags written inside the markdown. It implements a pragmatic subset
 * of MDX: CommonMark plus the GFM extensions in everyday use (tables, task
 * lists, strikethrough, autolinks) plus `<Component />` tags with
 * `className`/`style`. It does NOT evaluate `{javascript}` expressions or
 * `import` statements — that subset keeps the renderer light and predictable.
 *
 * Nothing here touches React; rendering lives in render.js.
 */

/* ---------- Frontmatter ---------- */

// Parse a leading `---` frontmatter block into a flat string map. Supports
// `key: value` lines, quoted values, flow arrays (["a", "b"] -> "a, b"), and
// trailing # comments. Returns { meta, body } (meta is empty if no block).
export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const raw of m[1].split("\n")) {
    const mm = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    // Quoted value: take the quoted content as-is (a # inside stays). Only a
    // comment may follow the closing quote; other trailing text keeps the
    // whole raw value.
    const q = v.match(/^"([^"]*)"\s*(?:#.*)?$/) || v.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (q) {
      v = q[1];
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
      // Flow array: ["a", "b"] -> "a, b" (best effort; left as-is if not JSON).
      if (v.startsWith("[") && v.endsWith("]")) {
        try {
          const arr = JSON.parse(v.replace(/'/g, '"'));
          if (Array.isArray(arr)) v = arr.join(", ");
        } catch {}
      }
    }
    meta[mm[1]] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

/* ---------- JSX / HTML element scanner ---------- */

// The one tag-name grammar every scanner shares: <Name, <ns.Name, <my-tag …
// (components.js matches the capitalized subset — keep the two in sync).
const TAG_NAME = "[A-Za-z][\\w.-]*";
const OPEN_TAG_RE = new RegExp(`^<(${TAG_NAME})`);
const CLOSE_TAG_RE = new RegExp(`^<\\/\\s*(${TAG_NAME})\\s*>`);
const BLOCK_TAG_RE = new RegExp(`^(\\s*)<${TAG_NAME}`);

// HTML elements that never have children or a closing tag, so `<br>` (no
// slash) parses as self-closing instead of scanning forever for `</br>`.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

// Read one opening tag at s[start] === '<'. Skips quoted attribute values and
// {braced} values so `>` inside them doesn't end the tag. Returns
// { name, attrs, end, selfClosing } or null if s[start] doesn't open a tag.
function readTag(s, start) {
  if (s[start] !== "<") return null;
  const nameM = OPEN_TAG_RE.exec(s.slice(start));
  if (!nameM) return null;
  const name = nameM[1];
  const attrStart = start + nameM[0].length;
  let i = attrStart;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) i++;
      i++;
      continue;
    }
    if (c === "{") {
      while (i < s.length && s[i] !== "}") i++;
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === ">") {
      return { name, attrs: s.slice(attrStart, i).trim(), end: i + 2, selfClosing: true };
    }
    if (c === ">") {
      const selfClosing = VOID_TAGS.has(name.toLowerCase());
      return { name, attrs: s.slice(attrStart, i).trim(), end: i + 1, selfClosing };
    }
    i++;
  }
  return null;
}

// Scan a full element (opening tag through matching close) starting at
// s[start] === '<'. Tracks tag nesting and skips ``` fences and
// <!-- comments --> inside the element body. Returns
// { name, attrs, inner, raw, end, selfClosing } or null if not balanced
// (so callers can keep accumulating lines).
export function scanElement(s, start) {
  const open = readTag(s, start);
  if (!open) return null;
  if (open.selfClosing) {
    return { name: open.name, attrs: open.attrs, inner: "", raw: s.slice(start, open.end), end: open.end, selfClosing: true };
  }
  let depth = 1;
  let i = open.end;
  while (i < s.length) {
    if (s.startsWith("```", i)) {
      const close = s.indexOf("```", i + 3);
      if (close === -1) return null;
      i = close + 3;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const close = s.indexOf("-->", i + 4);
      if (close === -1) return null;
      i = close + 3;
      continue;
    }
    if (s[i] === "<") {
      if (s[i + 1] === "/") {
        const m = CLOSE_TAG_RE.exec(s.slice(i));
        if (m) {
          depth--;
          if (depth === 0) {
            return {
              name: open.name,
              attrs: open.attrs,
              inner: s.slice(open.end, i),
              raw: s.slice(start, i + m[0].length),
              end: i + m[0].length,
              selfClosing: false,
            };
          }
          i += m[0].length;
          continue;
        }
        i++;
        continue;
      }
      if (/[A-Za-z]/.test(s[i + 1] || "")) {
        const t = readTag(s, i);
        if (t) {
          if (!t.selfClosing) depth++;
          i = t.end;
          continue;
        }
      }
    }
    i++;
  }
  return null;
}

// Parse a tag's attribute string into a props object. Supports name="v",
// name='v', name={v} (the braces' raw text as a string — expressions are NOT
// evaluated), and bare boolean names.
export function parseJSXAttrs(str) {
  const attrs = {};
  if (!str) return attrs;
  const re = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})|([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const name = m[1] || m[5];
    let value;
    if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = m[3];
    else if (m[4] !== undefined) value = m[4];
    else value = true;
    attrs[name] = value;
  }
  return attrs;
}

// Strip the common leading indentation from every non-blank line, so markdown
// nested inside an indented element body parses as if written flush left.
export function dedent(s) {
  const lines = s.split("\n");
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const n = l.match(/^[ \t]*/)[0].length;
    if (n < min) min = n;
  }
  if (!isFinite(min)) min = 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

/* ---------- Tables ---------- */

// Split one `| a | b |` row into trimmed cell strings. Respects \| escapes
// and pipes inside `inline code` (including multi-backtick spans).
export function splitTableRow(row) {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  let codeLen = 0; // length of the backtick run that opened the current code span
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") { current += "|"; i++; continue; }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      current += text.slice(i, i + run);
      i += run - 1;
      if (!codeLen) codeLen = run;
      else if (run === codeLen) codeLen = 0;
      continue;
    }
    if (ch === "|" && !codeLen) { cells.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

// True if the line is a table separator row like `|---|:---:|`.
function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

// Column alignments ("left" | "center" | "right" | undefined) from the
// `:---:` markers in a separator row.
function tableAlignments(separatorLine) {
  return splitTableRow(separatorLine).map((cell) => {
    const marker = cell.replace(/\s+/g, "");
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return undefined;
  });
}

// True if lines[i] starts a table: a `|` row followed by a separator row with
// the SAME cell count (the GFM rule — this is what keeps a stray dash line
// under prose containing a pipe from becoming a table).
function isTableStart(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return false;
  if (!isTableSeparator(lines[i + 1])) return false;
  return splitTableRow(lines[i]).length === splitTableRow(lines[i + 1]).length;
}

/* ---------- Lists ---------- */

// Match a list-item line: `- text`, `* text`, `+ text`, `1. text`, `1) text`.
// Returns { indent, marker, ordered, text } or null.
function matchListItem(line) {
  const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
  if (!m) return null;
  return {
    indent: m[1].length,
    marker: m[2],
    ordered: /\d/.test(m[2]),
    text: m[3],
  };
}

// GFM rule: a list can interrupt a paragraph only if it's a bullet list or an
// ordered list starting at 1 (so "…costs $2.\n2. next point" stays prose).
function listInterruptsParagraph(item) {
  return !item.ordered || item.marker === "1." || item.marker === "1)";
}

// Parse a run of list items starting at lines[start] (which must match
// matchListItem). Handles nested lists (deeper-indented items become the
// previous item's children), task-list checkboxes, indented and lazy
// continuation lines, fenced code inside items, and blank lines between items
// (loose lists render tight). Returns { block, next } where next is the first
// unconsumed line index.
function parseList(lines, start) {
  const first = matchListItem(lines[start]);
  const indent = first.indent;
  const ordered = first.ordered;
  const startNum = ordered ? parseInt(first.marker, 10) : 1;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line: the list continues only if the next non-blank line is still
    // list content (an item at >= this indent, or an indented continuation).
    if (!line.trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const m = matchListItem(lines[j]);
      const lead = lines[j].match(/^\s*/)[0].length;
      if ((m && m.indent >= indent) || (!m && lead > indent)) { i = j; continue; }
      break;
    }

    const m = matchListItem(line);

    // New item at this list's indent (same marker type).
    if (m && m.indent === indent && m.ordered === ordered) {
      const task = m.text.match(/^\[( |x|X)\]\s*(.*)$/);
      items.push({
        text: task ? task[2] : m.text,
        checked: task ? task[1] !== " " : undefined,
        children: [],
      });
      i++;
      continue;
    }

    // Deeper-indented item: a nested list owned by the previous item.
    if (m && m.indent > indent && items.length) {
      const nested = parseList(lines, i);
      items[items.length - 1].children.push(nested.block);
      i = nested.next;
      continue;
    }

    if (!items.length) break;
    const lead = line.match(/^\s*/)[0].length;

    // Fenced code indented under the previous item becomes its child block.
    const fence = lead > indent ? openFence(line.trim()) : null;
    if (fence) {
      const stripRe = new RegExp(`^\\s{0,${lead}}`);
      i++;
      const code = [];
      while (i < lines.length && !fence.closeRe.test(lines[i].trim())) {
        code.push(lines[i].replace(stripRe, ""));
        i++;
      }
      i++;
      items[items.length - 1].children.push({ type: "code", lang: fence.lang, code: code.join("\n") });
      continue;
    }

    // Indented continuation, or an unindented "lazy" line that doesn't start
    // a new block, extends the previous item — appended as a child paragraph
    // once the item has children, so content keeps its written order.
    if (lead > indent || !interruptsParagraph(lines, i)) {
      const item = items[items.length - 1];
      const last = item.children[item.children.length - 1];
      if (last && last.type === "p") last.text += "\n" + line.trim();
      else if (item.children.length) item.children.push({ type: "p", text: line.trim() });
      else item.text += "\n" + line.trim();
      i++;
      continue;
    }

    break;
  }

  const block = { type: ordered ? "ol" : "ul", items };
  if (ordered && startNum !== 1) block.start = startNum;
  return { block, next: i };
}

/* ---------- Link definitions ---------- */

// A reference-link definition line: [ref]: https://url "optional title"
// (up to 3 leading spaces, per CommonMark).
const LINK_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/;

// Reference-link definitions from a parsed block list (parseBlocks turns
// definition lines into "linkdef" blocks, so code fences can never leak
// false definitions). main.js puts the map on the render context; render.js
// skips the blocks themselves.
export function collectLinkDefs(blocks) {
  const defs = {};
  for (const b of blocks) {
    if (b.type === "linkdef") defs[b.ref] = { href: b.href, title: b.title };
  }
  return defs;
}

/* ---------- Block-level parser ---------- */

// An opening code fence: ``` or ~~~ (3 or more). Returns { lang, closeRe }
// (closeRe matches a closing run of the same char at least as long, so
// markdown examples can nest shorter fences inside longer ones) or null.
function openFence(line) {
  const m = line.match(/^(```+|~~~+)(.*)$/);
  if (!m) return null;
  return {
    lang: m[2].trim().split(/\s+/)[0] || "",
    closeRe: new RegExp(`^${m[1][0]}{${m[1].length},}\\s*$`),
  };
}

// A horizontal rule: 3+ of - * _ (same char), optionally space-separated.
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

// True if lines[i] begins a block that ends a paragraph mid-run (heading,
// fence, element/comment, blockquote, hr, table, or interrupting list).
function interruptsParagraph(lines, i) {
  const line = lines[i];
  if (/^#{1,6}\s/.test(line)) return true;
  if (/^(```|~~~)/.test(line)) return true;
  if (/^\s*<[!A-Za-z]/.test(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (isTableStart(lines, i)) return true;
  const item = matchListItem(line);
  if (item && item.indent === 0 && listInterruptsParagraph(item)) return true;
  return false;
}

// Parse markdown into a flat list of block descriptors:
//   { type: "heading", level, text }        ATX (#) and setext (===/---) headings
//   { type: "p", text }                     paragraphs (soft-wrapped lines kept)
//   { type: "code", lang, code }            ``` / ~~~ fenced + 4-space indented code
//   { type: "hr" }                          --- *** ___ (and spaced variants)
//   { type: "blockquote", text }            > quotes (text re-parsed recursively)
//   { type: "ul" | "ol", items, start? }    lists; items are { text, checked?, children }
//   { type: "table", headers, align, rows } GFM pipe tables
//   { type: "jsx", src }                    a standalone <Element>…</Element>
//   { type: "linkdef", ref, href, title }   [ref]: url definitions (invisible)
// HTML comments are dropped. Inline markdown inside blocks is handled later,
// in render.js.
export function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // HTML comment: skip it entirely (may span lines).
    if (/^\s*<!--/.test(line)) {
      let buf = line;
      while (!buf.includes("-->") && i + 1 < lines.length) { i++; buf += "\n" + lines[i]; }
      i++;
      continue;
    }

    // Raw JSX / HTML block (line begins with <Tag). Only a standalone block
    // when the element consumes the whole run of lines; an element with
    // trailing text ("<em>Hi</em> everyone") falls through to the paragraph
    // path so nothing is dropped.
    const jm = line.match(BLOCK_TAG_RE);
    if (jm) {
      const startCol = jm[1].length;
      let buf = line.slice(startCol);
      let j = i;
      let node = scanElement(buf, 0);
      while (!node && j + 1 < lines.length) {
        j++;
        buf += "\n" + lines[j];
        node = scanElement(buf, 0);
      }
      if (node && !buf.slice(node.end).trim()) {
        blocks.push({ type: "jsx", src: buf.slice(0, node.end) });
        i = j + 1;
        continue;
      }
      // fall through to paragraph handling
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/))) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2] });
      i++; continue;
    }

    // Fenced code (``` or ~~~).
    const fence = openFence(line);
    if (fence) {
      i++;
      const code = [];
      while (i < lines.length && !fence.closeRe.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", lang: fence.lang, code: code.join("\n") });
      continue;
    }

    if (HR_RE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    // Blockquote: > lines plus lazy continuation lines (non-blank lines that
    // don't start another block).
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && lines[i].trim() !== "") {
        if (/^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; continue; }
        if (interruptsParagraph(lines, i)) break;
        quote.push(lines[i]);
        i++;
      }
      blocks.push({ type: "blockquote", text: quote.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const align = tableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        if (!isTableSeparator(lines[i])) rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, align, rows });
      continue;
    }

    // Indented (4-space / tab) code block.
    if (/^(?: {4}|\t)/.test(line)) {
      const code = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        code.push(lines[i].replace(/^(?: {4}|\t)/, ""));
        i++;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      blocks.push({ type: "code", lang: "", code: code.join("\n") });
      continue;
    }

    if (matchListItem(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // Reference-link definition: becomes an invisible "linkdef" block that
    // collectLinkDefs reads and render.js skips.
    if ((m = line.match(LINK_DEF_RE))) {
      blocks.push({ type: "linkdef", ref: m[1].toLowerCase(), href: m[2], title: m[3] });
      i++;
      continue;
    }

    // Paragraph: always consumes at least the current line (so an unbalanced
    // `<` line can't loop forever), then accumulates until a blank line, a
    // setext underline (=== -> h1, --- -> h2), or an interrupting block.
    const para = [line];
    let setext = 0;
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      if (/^\s*=+\s*$/.test(lines[i])) { setext = 1; i++; break; }
      if (/^\s*-+\s*$/.test(lines[i])) { setext = 2; i++; break; }
      if (interruptsParagraph(lines, i)) break;
      para.push(lines[i]);
      i++;
    }
    if (setext) blocks.push({ type: "heading", level: setext, text: para.join(" ") });
    else blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

/* ---------- Misc text helpers ---------- */

// Turn heading text into an anchor id: lowercase, spaces to dashes, markdown
// and punctuation stripped ("Hello, World!" -> "hello-world").
export function slugify(text) {
  return plainText(text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
}

// Strip inline markdown down to its visible text: links/images keep their
// label, HTML comments disappear, emphasis/code/strikethrough markers are
// removed. Used for slugs and aria labels.
export function plainText(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}
