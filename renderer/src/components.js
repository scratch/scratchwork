/*
 * Runtime component loading.
 *
 * Components referenced in markdown as <TagName/> are loaded LAZILY at runtime
 * from ./components/<TagName>.js (default export) — they are NOT part of the
 * bundle. This is what lets an agent add a component to a project without
 * rebuilding the renderer. Components use the React on `window` (set in
 * main.js), e.g. `const React = window.React`.
 */

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

function stripInlineCodeSpans(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }

    const start = i;
    while (i < line.length && line[i] === "`") i++;
    const ticks = line.slice(start, i);
    const end = line.indexOf(ticks, i);
    if (end === -1) {
      out += ticks;
      continue;
    }
    out += " ".repeat(end + ticks.length - start);
    i = end + ticks.length;
  }
  return out;
}

// Walk the raw markdown collecting capitalized element names, skipping fenced
// and inline code so component examples shown as code aren't loaded.
export function collectComponentNames(text) {
  const names = new Set();
  const lines = text.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const searchable = stripInlineCodeSpans(line);
    const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
    let m;
    while ((m = re.exec(searchable)) !== null) names.add(m[1]);
  }
  return [...names];
}
