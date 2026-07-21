import { runLocalCloudflareServer } from "@scratchwork/server-deploy-cloudflare";
import { config } from "./cloudflare-config";

// Runs the same Worker and binding names used in production, backed by Wrangler's
// persistent local R2 and D1 implementations.
await runLocalCloudflareServer(config, { envFile: ".env" });
