import { runLocalCloudflareServer } from "@scratchwork/server-deploy-cloudflare";
import { config } from "./cloudflare-config";

// Runs the same Worker and binding names used in production, backed by Wrangler's
// persistent local R2 and D1 implementations. The Access edge is simulated with
// generated key material, so no `.env`, Cloudflare account, or Access application
// is needed for the local run.
await runLocalCloudflareServer(config, { simulateAccess: true });
