import { dirnameSitePath, joinSitePath, type SitePath } from "./paths";

function stripInlineCodeSpans(line: string): string {
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

// Walk raw markdown collecting capitalized element names, skipping fenced and
// inline code so examples shown as code do not trigger component loading.
export function collectComponentNames(text: string): ReadonlyArray<string> {
  const names = new Set<string>();
  const lines = text.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const searchable = stripInlineCodeSpans(line);
    const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
      names.add(match[1]);
    }
  }
  return [...names];
}

export function componentFileCandidates(
  markdownPath: SitePath,
  componentName: string,
): ReadonlyArray<SitePath> {
  const base = dirnameSitePath(markdownPath);
  return [
    joinSitePath(base, `components/${componentName}.js`),
    joinSitePath(base, `${componentName}.js`),
  ];
}
