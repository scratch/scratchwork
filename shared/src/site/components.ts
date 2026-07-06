/*
 * Discovery of custom components referenced from Markdown: which capitalized
 * element names a document uses, and where their .js definitions may live
 * relative to the document. The scan rules mirror the runtime loader — keep
 * this file in sync with renderer/src/components.js so dev diagnostics agree
 * with what the renderer actually loads.
 */
import { dirnameSitePath, joinSitePath, type SitePath } from "./paths";

/**
 * Blanks out `inline code` spans in a line so their contents are not scanned.
 * A span closes only on a backtick run of exactly the opening length (the
 * CommonMark rule).
 */
function stripInlineCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }

    let run = 1;
    while (line[i + run] === "`") run++;
    let j = i + run;
    let end = -1;
    while (j < line.length) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let r = 1;
      while (line[j + r] === "`") r++;
      if (r === run) {
        end = j;
        break;
      }
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

/**
 * Walks raw markdown collecting capitalized element names, skipping fenced
 * and inline code and single-line HTML comments so examples shown as code (or
 * commented out) do not trigger component loading. Matches `<Card` even when
 * the attributes continue on the next line.
 */
export function collectComponentNames(text: string): ReadonlyArray<string> {
  const names = new Set<string>();
  const lines = text.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const searchable = stripInlineCodeSpans(line).replace(/<!--[\s\S]*?-->/g, "");
    const re = /<([A-Z][\w.-]*)(?=[\s/>]|$)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
      names.add(match[1]);
    }
  }
  return [...names];
}

/** Lists the paths where a component's .js file may live, most specific first. */
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
