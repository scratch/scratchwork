/*
 * The Scratchwork publishing server — a single, runtime-agnostic request
 * handler. It runs unchanged on Bun (the local server) and on Cloudflare Workers
 * (production); the only thing that differs is the storage adapter passed in.
 *
 * It does two jobs:
 *
 *   1. Accept deploys.   POST /api/deploy  with a gzipped Scratchwork bundle
 *      (see shared/bundle.js). The body is unpacked, validated, written to
 *      storage under a new deploy id, and the project's live deploy is flipped
 *      to it. Returns the project's URL.
 *
 *   2. Serve content.    GET /<id>/...  resolves the request against the
 *      project's live deploy using the SAME rules as `scratchwork dev`
 *      (shared/resolve.js). Because `scratchwork publish` bakes each markdown
 *      route's renderer shell into a static .html at publish time, the server
 *      never needs to know about markdown — it's a plain static host, and the
 *      result renders byte-for-byte like `scratchwork dev`.
 *
 * Deliberately tiny: no framework, no database, no cookies, no OAuth. Auth, when
 * enabled, is a bearer token. Everything is plain Request/Response.
 */
import { candidates, isSafePath } from "../../shared/resolve.js";
import { unpackBundle } from "../../shared/bundle.js";
import { FIGURE_SVG } from "../../shared/figure.js";
import { contentType, cacheControl, SECURITY_HEADERS, json, generateId } from "./util.js";

const PROJECT_ID_RE = /^[a-z0-9]+$/i;

export function createApp({ storage, config = {} }) {
  const authTokens = (config.authTokens || []).filter(Boolean);
  const authRequired = authTokens.length > 0;
  // Validate numeric config: a bad env var (NaN, ≤0) must not silently disable
  // the size guard (`x > NaN` is always false), so fall back to the default.
  const posNum = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  const maxDeployBytes = posNum(config.maxDeployBytes, 25 * 1024 * 1024); // compressed upload cap
  const maxUncompressedBytes = posNum(config.maxUncompressedBytes, 100 * 1024 * 1024); // gzip-bomb guard
  const maxFiles = posNum(config.maxFiles, 10000);
  const baseDomain = config.baseDomain ? config.baseDomain.toLowerCase() : null;

  // ---- auth -------------------------------------------------------------
  function checkAuth(request) {
    if (!authRequired) return true;
    const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const token = (m ? m[1] : "").trim();
    return token.length > 0 && authTokens.includes(token);
  }

  // ---- deploy -----------------------------------------------------------
  async function handleDeploy(request, url) {
    if (!checkAuth(request)) {
      return json({ error: authRequired ? "Invalid or missing token" : "Unauthorized" }, 401);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength && contentLength > maxDeployBytes) {
      return json({ error: `Deploy too large (max ${maxDeployBytes} bytes compressed)` }, 413);
    }

    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > maxDeployBytes) {
      return json({ error: `Deploy too large (max ${maxDeployBytes} bytes compressed)` }, 413);
    }

    let files;
    try {
      files = await unpackBundle(buf, { maxBytes: maxUncompressedBytes });
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes("uncompressed size limit")) {
        return json({ error: `Deploy too large (max ${maxUncompressedBytes} bytes uncompressed)` }, 413);
      }
      return json({ error: "Invalid bundle: " + msg }, 400);
    }

    if (files.length === 0) return json({ error: "Empty deploy" }, 400);
    if (files.length > maxFiles) return json({ error: `Too many files (max ${maxFiles})` }, 400);

    let totalBytes = 0;
    for (const f of files) {
      if (!isSafePath(f.path)) return json({ error: "Unsafe file path: " + f.path }, 400);
      totalBytes += f.data.length;
    }

    const name = (url.searchParams.get("name") || "site").slice(0, 100);
    const requestedId = (url.searchParams.get("id") || "").trim();
    const visibility = url.searchParams.get("visibility") === "unlisted" ? "unlisted" : "public";
    const now = new Date().toISOString();

    let project = null;
    if (requestedId && PROJECT_ID_RE.test(requestedId)) {
      project = await storage.getProject(requestedId);
    }
    let created = false;
    if (!project) {
      project = {
        id: generateId(),
        name,
        visibility,
        liveDeployId: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      created = true;
    }

    const deployId = generateId();
    await storage.putFiles(deployId, files);

    project.name = name;
    project.visibility = visibility;
    project.liveDeployId = deployId;
    project.version = (project.version || 0) + 1;
    project.updatedAt = now;
    project.lastDeploy = { id: deployId, fileCount: files.length, totalBytes, createdAt: now };
    await storage.saveProject(project);

    const base = (config.publicBaseUrl || url.origin).replace(/\/+$/, "");
    return json(
      {
        ok: true,
        created,
        id: project.id,
        name: project.name,
        version: project.version,
        url: `${base}/${project.id}/`,
        fileCount: files.length,
        totalBytes,
      },
      created ? 201 : 200,
    );
  }

  // ---- content serving --------------------------------------------------
  async function serveContent(request, projectId, contentPath) {
    if (!PROJECT_ID_RE.test(projectId)) return notFound();
    const project = await storage.getProject(projectId);
    if (!project || !project.liveDeployId) return notFound();

    for (const key of candidates(contentPath)) {
      const file = await storage.getFile(project.liveDeployId, key);
      if (file) return serveFile(request, key, file);
    }

    // Default favicon, exactly as `scratchwork dev` does: when a project ships
    // none of its own, answer the browser's /favicon.ico with the figure mark.
    if (contentPath === "/favicon.ico") return faviconResponse();

    return notFound();
  }

  function serveFile(request, key, file) {
    const headers = {
      "Content-Type": contentType(key),
      "Cache-Control": cacheControl(key),
      ...SECURITY_HEADERS,
    };
    if (file.etag) {
      headers["ETag"] = file.etag;
      if (request.headers.get("if-none-match") === file.etag) {
        return new Response(null, { status: 304, headers });
      }
    }
    return new Response(file.body, { headers });
  }

  // ---- main entry -------------------------------------------------------
  return async function handle(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    if (pathname === "/api/deploy") {
      if (method !== "POST") return json({ error: "Method not allowed" }, 405);
      try {
        return await handleDeploy(request, url);
      } catch (e) {
        return json({ error: "Deploy failed: " + (e?.message || e) }, 500);
      }
    }
    if (pathname === "/api/whoami") {
      return json({ ok: true, authRequired, authenticated: checkAuth(request) });
    }
    if (pathname === "/api/health") return json({ ok: true });
    if (pathname === "/install.sh") return installScript(url, config);

    // Subdomain hosting (optional): <id>.<baseDomain> serves that project at the
    // host root, so sites that use absolute (/foo) asset paths work too.
    if (baseDomain) {
      const host = (request.headers.get("host") || url.host).toLowerCase().split(":")[0];
      const suffix = "." + baseDomain;
      if (host.endsWith(suffix)) {
        const sub = host.slice(0, -suffix.length);
        if (sub && sub !== "www" && sub !== "app") {
          return serveContent(request, sub, decodePath(pathname) || "/");
        }
      }
    }

    if (pathname === "/" || pathname === "") return landing(url);
    if (pathname === "/favicon.ico") return faviconResponse();
    if (method !== "GET" && method !== "HEAD") return json({ error: "Method not allowed" }, 405);

    // Path hosting: /<id>/...  — the default, single-domain mode.
    const projectId = pathname.split("/")[1] || "";
    if (projectId) {
      const rest = pathname.slice(("/" + projectId).length);
      return serveContent(request, projectId, decodePath(rest) || "/");
    }
    return notFound();
  };
}

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function faviconResponse() {
  return new Response(FIGURE_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": cacheControl(".svg"), ...SECURITY_HEADERS },
  });
}

function landing(url) {
  const base = url.origin;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Scratchwork</title>
<style>
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; color: #1f2937; }
  h1 { font-size: 1.5rem; } code { background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { background: #f3f4f6; padding: 1rem; border-radius: 8px; overflow:auto; }
  a { color: #da752f; }
</style></head>
<body>
  <h1>Scratchwork</h1>
  <p>This is a Scratchwork publishing server. It hosts static sites published
     with the <code>scratchwork</code> CLI.</p>
  <pre>scratchwork publish [dir] --server ${base}</pre>
  <p>Published sites live at <code>${base}/&lt;id&gt;/</code>.</p>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

// A minimal installer for the compiled CLI binary. Operators point
// SCRATCHWORK_DOWNLOAD_BASE at wherever they host release binaries (e.g. a
// GitHub releases URL); the script picks the asset for the user's platform.
//
// The base URL is interpolated into a bash script, so it MUST be a plain http(s)
// URL with no shell metacharacters — anything else falls back to the origin to
// avoid injecting commands into a script users pipe to bash.
function safeBaseUrl(candidate, fallback) {
  if (typeof candidate === "string" && /^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(candidate)) {
    return candidate.replace(/\/+$/, "");
  }
  return fallback.replace(/\/+$/, "");
}

function installScript(url, config) {
  const base = safeBaseUrl(config.downloadBase, `${url.origin}/dist`);
  const script = `#!/usr/bin/env bash
set -euo pipefail
# Scratchwork CLI installer.
BASE="\${SCRATCHWORK_DOWNLOAD_BASE:-${base}}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; esac
case "$OS" in darwin) TARGET="darwin-$ARCH";; linux) TARGET="linux-$ARCH";; *) echo "Unsupported OS: $OS" >&2; exit 1;; esac
DEST="\${SCRATCHWORK_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"
URL="$BASE/scratchwork-$TARGET"
echo "Downloading $URL"
curl -fSL "$URL" -o "$DEST/scratchwork"
chmod +x "$DEST/scratchwork"
echo "Installed scratchwork to $DEST/scratchwork"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add $DEST to your PATH to use 'scratchwork'.";; esac
`;
  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "attachment; filename=install.sh",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}
