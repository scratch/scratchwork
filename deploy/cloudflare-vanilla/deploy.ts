import { deployServer } from "@scratchwork/server-deploy-cloudflare";
import { config } from "./cloudflare-config";

const result = await deployServer(config, { envFile: ".env" });

console.log(`scratchwork Cloudflare Worker deployed: ${result.workerName}`);
console.log(
  `publish with: scratchwork publish --server https://${config.server.appDomain}`,
);
