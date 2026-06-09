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

// Walk the raw markdown collecting capitalized element names, skipping fenced
// code blocks so component examples shown in ``` aren't loaded.
export function collectComponentNames(text) {
  const names = new Set();
  const lines = text.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
    let m;
    while ((m = re.exec(line)) !== null) names.add(m[1]);
  }
  return [...names];
}
