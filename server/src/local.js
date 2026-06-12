#!/usr/bin/env bun
/*
 * Local Scratchwork server. Same app as production (app.js), backed by the
 * filesystem instead of R2 — so you can run the exact serving logic on your own
 * machine with zero setup and zero dependencies (Bun built-ins only):
 *
 *   bun src/local.js                 # serve on :8787, data in ./.scratchwork-data
 *   bun src/local.js --port 9000 --data /tmp/sw
 *
 * Then point the CLI at it:
 *
 *   scratchwork publish ./docs --server http://localhost:8787
 *
 * Auth is OFF by default (it's your machine). Set SCRATCHWORK_TOKEN to require a
 * bearer token, matching production.
 */
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { createFsStorage } from "./storage-fs.js";

const args = process.argv.slice(2);
let port = process.env.PORT ? Number(process.env.PORT) : 8787;
let dataDir = process.env.SCRATCHWORK_DATA || "./.scratchwork-data";
let publicBaseUrl = process.env.PUBLIC_BASE_URL || "";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else if (a === "--port" || a === "-p") {
    port = Number(args[++i]);
  } else if (a.startsWith("--port=")) {
    port = Number(a.slice("--port=".length));
  } else if (a === "--data") {
    dataDir = args[++i];
  } else if (a.startsWith("--data=")) {
    dataDir = a.slice("--data=".length);
  } else if (a === "--base-url") {
    publicBaseUrl = args[++i];
  } else if (a.startsWith("--base-url=")) {
    publicBaseUrl = a.slice("--base-url=".length);
  } else {
    console.error(`scratchwork server: unknown argument "${a}"`);
    process.exit(1);
  }
}

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`scratchwork server: invalid --port "${port}"`);
  process.exit(1);
}

const authTokens = (process.env.SCRATCHWORK_TOKEN || process.env.AUTH_TOKENS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const handle = createApp({
  storage: createFsStorage(resolve(dataDir)),
  config: {
    authTokens,
    publicBaseUrl: publicBaseUrl || undefined,
    maxDeployBytes: process.env.MAX_DEPLOY_BYTES ? Number(process.env.MAX_DEPLOY_BYTES) : undefined,
    maxUncompressedBytes: process.env.MAX_UNCOMPRESSED_BYTES ? Number(process.env.MAX_UNCOMPRESSED_BYTES) : undefined,
  },
});

const server = Bun.serve({ port, idleTimeout: 0, fetch: (req) => handle(req) });

const url = `http://localhost:${server.port}`;
console.log(`\n  scratchwork server`);
console.log(`  listening on  ${url}`);
console.log(`  data dir      ${resolve(dataDir)}`);
console.log(`  auth          ${authTokens.length ? "bearer token required" : "off (open)"}`);
console.log(`\n  publish to it:  scratchwork publish [dir] --server ${url}\n`);

function printHelp() {
  console.log(`scratchwork server — host published Scratchwork sites locally

Usage:
  bun src/local.js [options]

Options:
  -p, --port N        Port to listen on (default: 8787; 0 picks a free port)
      --data DIR      Where to store deploys (default: ./.scratchwork-data)
      --base-url URL  Public base URL to return to clients (default: request origin)
  -h, --help          Show this help

Env:
  SCRATCHWORK_TOKEN   Require this bearer token for deploys (default: open)`);
}
