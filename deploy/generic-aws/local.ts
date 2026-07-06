import { runLocalServer } from "@scratchwork/server-deploy-local";
import { server } from "./server-config";

// Runs the generic AWS server settings locally with local file storage and an
// in-memory database.
runLocalServer({ server });
