/*
 * Runtime component loading.
 *
 * Components referenced in markdown as <TagName/> are loaded LAZILY at runtime
 * (default export) — they are NOT part of the bundle. This is what lets an
 * agent add a component to a project without rebuilding the renderer.
 * Components use the React on `window` (set in main.js), e.g.
 * `const React = window.React`.
 */

// Import ./components/<name>.js (falling back to ./<name>.js) relative to the
// markdown file's directory and return its default export, or null if neither
// path loads.
export async function loadComponent(name, base) {
  for (const path of [`${base}components/${name}.js`, `${base}${name}.js`]) {
    try {
      const mod = await import(path);
      if (mod && mod.default) return mod.default;
    } catch (err) {
      // try next path
    }
  }
  console.warn(`[scratchwork] failed to load component ${name}`);
  return null;
}

// Blank out `inline code` spans so the component scan below never matches
// tags shown as code examples. A span closes only on a backtick run of
// exactly the opening length (the CommonMark rule, matching splitTableRow).
// Keep in sync with shared/src/site/components.ts, which the CLI dev
// diagnostics use to predict what this loader will do.
function stripInlineCodeSpans(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let run = 1;
    while (line[i + run] === "`") run++;
    // find the next backtick run of exactly the same length
    let j = i + run;
    let end = -1;
    while (j < line.length) {
      if (line[j] !== "`") { j++; continue; }
      let r = 1;
      while (line[j + r] === "`") r++;
      if (r === run) { end = j; break; }
      j += r;
    }
    if (end === -1) {
      out += line.slice(i, i + run);
      i += run;
      continue;
    }
    out += " ".repeat(end + run - i);
    i = end + run;
  }
  return out;
}

// Walk the raw markdown collecting capitalized element names (the components
// to load), skipping fenced and inline code and single-line HTML comments so
// component examples shown as code (or commented out) aren't loaded. Matches
// `<Card` even when the attributes continue on the next line. The name
// grammar is the capitalized subset of parser.js's TAG_NAME.
export function collectComponentNames(text) {
  const names = new Set();
  const lines = text.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const searchable = stripInlineCodeSpans(line).replace(/<!--[\s\S]*?-->/g, "");
    const re = /<([A-Z][\w.-]*)(?=[\s/>]|$)/g;
    let m;
    while ((m = re.exec(searchable)) !== null) names.add(m[1]);
  }
  return [...names];
}
