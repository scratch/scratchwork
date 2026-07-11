import type { CloudflareDeployServerConfig } from "@scratchwork/server-deploy-cloudflare";
import { server } from "./server-config";

/** The complete sndbx.sh Cloudflare configuration, shared by remote deploys and the
 * local Wrangler Worker runtime. Routes are ignored locally; binding names are not. */
export const config = {
  server,

  deploy: {
    workerName: "scratchwork",
    r2Bucket: "scratchwork-sndbx-sh",
    d1Database: "scratchwork-sndbx-sh-projects",
    routes: [
      { pattern: "sndbx.sh/*" },
      { pattern: "www.sndbx.sh/*" },
      { pattern: "app.sndbx.sh/*" },
      { pattern: "pages.sndbx.sh/*" },
    ],
    zoneName: "sndbx.sh",
  },
} satisfies CloudflareDeployServerConfig;
