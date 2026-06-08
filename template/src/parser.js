/*
 * Markdown + JSX parser.
 *
 * This is a small, dependency-free, hand-rolled parser. It produces a tree of
 * plain block descriptors (see parseBlocks) plus helpers for scanning JSX/HTML
 * element tags written inside the markdown. It deliberately implements a
 * pragmatic subset of MDX: standard Markdown plus `<Component />` tags and
 * `className`. It does NOT evaluate `{javascript}` expressions or `import`
 * statements — that subset keeps the renderer light and predictable.
 *
 * Nothing here touches React; rendering lives in render.js.
 */

/* ---------- Frontmatter ---------- */

export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const raw of m[1].split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    const q = v.match(/^"([^"]*)"$/) || v.match(/^'([^']*)'$/);
    if (q) v = q[1];
    meta[mm[1]] = v;
  }
  return { meta, body: md.slice(m[0].length) };
}

/* ---------- JSX / HTML element scanner ---------- */

// Read an opening tag at s[start] === '<'. Returns { name, attrs, end,
// selfClosing } or null.
function readTag(s, start) {
  if (s[start] !== "<") return null;
  const nameM = /^<\s*([A-Za-z][\w.-]*)/.exec(s.slice(start));
  if (!nameM) return null;
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
    if (c === "/" && s[i + 1] === ">") {
      return { name: nameM[1], attrs: s.slice(attrStart, i).trim(), end: i + 2, selfClosing: true };
    }
    if (c === ">") {
      return { name: nameM[1], attrs: s.slice(attrStart, i).trim(), end: i + 1, selfClosing: false };
    }
    i++;
  }
  return null;
}

// Scan a full element starting at s[start] === '<'. Returns
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
    if (s[i] === "<") {
      if (s[i + 1] === "/") {
        const m = /^<\/\s*([A-Za-z][\w.-]*)\s*>/.exec(s.slice(i));
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

export function splitTableRow(row) {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && next === "|") { current += "|"; i++; continue; }
    if (ch === "`") { inCode = !inCode; current += ch; continue; }
    if (ch === "|" && !inCode) { cells.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

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

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes("|") && isTableSeparator(lines[i + 1]);
}

/* ---------- Block-level parser ---------- */

export function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Raw JSX / HTML block (line begins with <Tag)
    const jm = line.match(/^(\s*)<([A-Za-z][\w.-]*)/);
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
      if (node) {
        blocks.push({ type: "jsx", src: buf.slice(0, node.end) });
        i = j + 1;
        continue;
      }
      // fall through to paragraph handling if not balanced
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/))) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2] });
      i++; continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
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

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      blocks.push({ type: "ol", items });
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const next = lines[i];
      if (/^#{1,6}\s/.test(next)) break;
      if (next.startsWith("```")) break;
      if (/^\s*<[A-Za-z][\w.-]*/.test(next)) break;
      if (/^[-*+]\s+/.test(next)) break;
      if (/^\d+\.\s+/.test(next)) break;
      if (/^>\s?/.test(next)) break;
      para.push(next);
      i++;
    }
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

/* ---------- Misc text helpers ---------- */

export function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
}

export function plainText(text) {
  return text.replace(/[*_`]/g, "");
}
