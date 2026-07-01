import {
  deployServer,
  type CloudflareServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

const config = {
  publicUrl: "https://sndbx.sh",
  auth: "google",
  authSessionSeconds: 2_592_000,

  workerName: "scratchwork",
  r2Bucket: "scratchwork-sndbx-sh",
  route: "sndbx.sh/*",
  zoneName: "sndbx.sh",
} satisfies CloudflareServerConfig;

const result = await deployServer(config, { envFile: ".env" });

console.log(`scratchwork Cloudflare Worker deployed: ${result.workerName}`);
console.log(`publish with: scratchwork publish --server ${config.publicUrl}`);
