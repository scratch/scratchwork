import type { CloudflareDeployServerConfig } from "@scratchwork/server-deploy-cloudflare";
import { server } from "./server-config";

/** The complete scratchwork.dev Cloudflare configuration, shared by remote deploys and
 * the local Wrangler Worker runtime. Routes are ignored locally; binding names are not. */
export const config = {
  server,

  deploy: {
    workerName: "scratchwork-dev",
    r2Bucket: "scratchwork-dev",
    d1Database: "scratchwork-dev-projects",
    routes: [
      { pattern: "scratchwork.dev/*" },
      { pattern: "www.scratchwork.dev/*" },
      { pattern: "app.scratchwork.dev/*" },
      { pattern: "pages.scratchwork.dev/*" },
    ],
    zoneName: "scratchwork.dev",
  },
} satisfies CloudflareDeployServerConfig;
