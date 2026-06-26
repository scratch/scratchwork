/*
 * Cloudflare Worker entrypoint. Wires the runtime-agnostic app (app.js) to R2
 * storage and reads config from the Worker environment. This is the ONLY
 * Cloudflare-specific file.
 *
 * Deploy:
 *   1. wrangler r2 bucket create scratchwork
 *   2. wrangler secret put SCRATCHWORK_TOKEN     # the deploy token clients use
 *   3. wrangler deploy
 *
 * Env:
 *   FILES                 R2 bucket binding (wrangler.toml)
 *   DB                    D1 database binding (wrangler.toml); metadata store
 *   SCRATCHWORK_TOKEN     comma-separated deploy token(s); omit to allow anyone
 *   BASE_DOMAIN           optional; enables <id>.<BASE_DOMAIN> subdomain hosting
 *   PUBLIC_BASE_URL       optional; overrides the base URL returned to clients
 *   MAX_DEPLOY_BYTES      optional; compressed upload cap (default 25 MB)
 *   SCRATCHWORK_DOWNLOAD_BASE  optional; base URL for /install.sh binaries
 */
import { createApp } from "./app.js";
import { createR2Storage } from "./storage-r2.js";
import { createD1Client } from "./db/client.js";

function tokens(env) {
  return (env.SCRATCHWORK_TOKEN || env.AUTH_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default {
  async fetch(request, env) {
    const handle = createApp({
      storage: createR2Storage(env.FILES),
      // The D1-backed metadata store. Bound here so the auth/projects layers can
      // use it; the current content-serving path doesn't yet. Null when the
      // binding is absent (e.g. `wrangler dev` without a configured database).
      db: env.DB ? createD1Client(env.DB) : null,
      config: {
        authTokens: tokens(env),
        baseDomain: env.BASE_DOMAIN || undefined,
        publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
        downloadBase: env.SCRATCHWORK_DOWNLOAD_BASE || undefined,
        maxDeployBytes: env.MAX_DEPLOY_BYTES ? Number(env.MAX_DEPLOY_BYTES) : undefined,
        maxUncompressedBytes: env.MAX_UNCOMPRESSED_BYTES ? Number(env.MAX_UNCOMPRESSED_BYTES) : undefined,
      },
    });
    return handle(request);
  },
};
