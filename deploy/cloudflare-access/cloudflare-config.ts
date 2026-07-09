import type { CloudflareDeployServerConfig } from "@scratchwork/server-deploy-cloudflare";
import { server } from "./server-config";

/** The complete Access-protected Cloudflare configuration, shared by remote deploys and
 * the local Wrangler Worker runtime. Routes are ignored locally; binding names are not.
 * Both routed hostnames must be covered by the Cloudflare Access application whose AUD
 * tag is configured in `.env` — see README.md. */
export const config = {
  server,

  deploy: {
    workerName: "scratchwork-access",
    r2Bucket: "scratchwork-access-sndbx-sh",
    d1Database: "scratchwork-access-sndbx-sh-projects",
    routes: [
      { pattern: "access.sndbx.sh/*" },
      { pattern: "access-pages.sndbx.sh/*" },
    ],
    zoneName: "sndbx.sh",
  },
} satisfies CloudflareDeployServerConfig;
