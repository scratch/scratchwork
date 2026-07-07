#!/usr/bin/env bun
import { runLocalCloudflareServer } from "../src/deploy";

await runLocalCloudflareServer({}, {
  argv: Bun.argv.slice(2),
  loadPackageEnvFiles: true,
});
