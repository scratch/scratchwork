/*
 * Static request resolution — the single rule that maps a URL path to the file
 * that should answer it. This is the SAME resolution `scratchwork dev` performs
 * (see cli/scratchwork.ts `handle`), factored out so the publishing server
 * resolves requests identically. That parity is what guarantees a published site
 * renders exactly like `scratchwork dev` did.
 *
 * Pure and dependency-free: takes a decoded, project-relative pathname (the part
 * after any `/<id>` deploy prefix) and returns the ordered list of candidate
 * file keys (relative, no leading slash) to look up in storage. The first one
 * that exists wins.
 *
 * Note on markdown: `scratchwork dev` answers a markdown route (/foo where
 * foo.md exists) by serving a renderer SHELL. `scratchwork publish` bakes that
 * shell out to foo.html at publish time, so on the server a markdown route is
 * just an ordinary .html lookup — no special markdown handling needed here.
 */

// Reject path traversal / absolute / weird paths. Mirrors the publish-side
// validation so a key that was rejected at pack time can't appear at serve time.
export function isSafePath(p) {
  if (typeof p !== "string") return false;
  if (!p || p.length > 1024) return false;
  if (p.includes("..")) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  if (p.includes("\0")) return false;
  return true;
}

// Collapse `//`, strip a leading `/` and any `./` segments.
function clean(rel) {
  return rel.replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/\.\//g, "/");
}

// The ordered candidate keys for a (decoded, project-relative) pathname.
// Returns [] if the path is unsafe.
//
//   "/"                 -> ["index.html"]
//   "/about/"           -> ["about/index.html"]
//   "/about"            -> ["about.html", "about/index.html"]
//   "/style.css"        -> ["style.css"]          (has an extension → exact)
//   "/components/X.js"  -> ["components/X.js"]
export function candidates(pathname) {
  const decoded = clean(pathname);
  const rel = decoded.replace(/^\/+/, "");

  // Direct file request: the last segment names an extension.
  const last = decoded.split("/").pop() || "";
  if (last.includes(".")) {
    return isSafePath(rel) ? [rel] : [];
  }

  // Extensionless route → an authored/baked .html page.
  const dirStyle = decoded === "/" || decoded.endsWith("/");
  const route = rel.replace(/\/+$/, ""); // "" for the site root
  const out = dirStyle
    ? [join(route, "index.html")]
    : [route + ".html", join(route, "index.html")];
  return out.filter(isSafePath);
}

function join(a, b) {
  if (!a) return b;
  return a.replace(/\/+$/, "") + "/" + b;
}
