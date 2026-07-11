import {
  runLocalCloudflareServer,
  type CloudflareDeployServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

/** Local-only Worker deployment for exercising Cloudflare Access authentication with
 * persistent R2 and D1 state. There is deliberately no remote deploy command. */
const config = {
  server: {
    auth: "cloudflare-access",
    authSessionSeconds: 2_592_000,
    allowedUsers: "public",
    maxVisibility: "public",
    usersCanSetProjectNames: true,
    defaultVisibility: "private",
  },
  deploy: {
    workerName: "scratchwork-cf-access-local",
    r2Bucket: "scratchwork-cf-access-local",
    d1Database: "scratchwork-cf-access-local-projects",
  },
} satisfies CloudflareDeployServerConfig;

await runLocalCloudflareServer(config, { simulateAccess: true });
