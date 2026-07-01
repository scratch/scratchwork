import {
  deployServer,
  type CloudflareDeployServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

const config = {
  server: {
    publicUrl: "https://sndbx.sh",
    auth: "google",
    authSessionSeconds: 2_592_000,
  },

  deploy: {
    workerName: "scratchwork",
    r2Bucket: "scratchwork-sndbx-sh",
    route: "sndbx.sh/*",
    zoneName: "sndbx.sh",
  },
} satisfies CloudflareDeployServerConfig;

const result = await deployServer(config, { envFile: ".env" });

console.log(`scratchwork Cloudflare Worker deployed: ${result.workerName}`);
console.log(`publish with: scratchwork publish --server ${config.server.publicUrl}`);
