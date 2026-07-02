import { runLocalServer } from "@scratchwork/server-deploy-local";
import { server } from "./server-config";

// Runs the sndbx.sh server settings locally: app on http://localhost:<port>, published
// content on http://pages.localhost:<port> (mirroring the app./pages. domain split),
// local file storage, in-memory database.
await runLocalServer({ server });
