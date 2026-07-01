import {
  deployServer,
  type CloudflareDeployServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

const config = {
  server: {
    appDomain: "app.sndbx.sh",
    contentDomain: "pages.sndbx.sh",
    auth: "google",
    authSessionSeconds: 2_592_000,
    allowedUsers: "public",
    maxVisibility: "public",
    projectPath: "workspace/project",
    defaultWorkspace: "personal",
    defaultVisibility: "private",
  },

  deploy: {
    workerName: "scratchwork",
    r2Bucket: "scratchwork-sndbx-sh",
    d1Database: "scratchwork-sndbx-sh-projects",
    routes: [
      { pattern: "sndbx.sh/*", zoneName: "sndbx.sh" },
      { pattern: "www.sndbx.sh/*", zoneName: "sndbx.sh" },
      { pattern: "app.sndbx.sh/*", zoneName: "sndbx.sh" },
      { pattern: "pages.sndbx.sh/*", zoneName: "sndbx.sh" },
    ],
    zoneName: "sndbx.sh",
  },
} satisfies CloudflareDeployServerConfig;

const result = await deployServer(config, { envFile: ".env" });

console.log(`scratchwork Cloudflare Worker deployed: ${result.workerName}`);
console.log(
  `publish with: scratchwork publish --server https://${config.server.appDomain}`,
);
