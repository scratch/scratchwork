#!/usr/bin/env bun
import { deployServer } from "../src/deploy";

const result = await deployServer({}, { argv: Bun.argv.slice(2), loadPackageEnvFiles: true });

console.log(`scratchwork Cloudflare Worker deployed: ${result.workerName}`);
console.log(`publish with: scratchwork publish --server ${result.publicUrl ?? "https://<your-worker-domain>"}`);
