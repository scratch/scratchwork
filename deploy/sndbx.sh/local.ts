import { runLocalServer } from "@scratchwork/deploy-local";
import { server } from "./server-config";

// Runs the sndbx.sh server settings locally: app on http://localhost:<port>, published
// content on http://127.0.0.1:<port> (two loopback origins standing in for the
// app./pages. domain split), local file storage, in-memory database.
await runLocalServer({ server });
