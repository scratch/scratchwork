#!/usr/bin/env bun
import { deployServer } from "../src/deploy";

const result = await deployServer({}, { argv: Bun.argv.slice(2), loadPackageEnvFiles: true });

console.log(`scratchwork AWS server deployed: ${result.url}`);
console.log(`publish with: scratchwork publish --server ${result.url}`);
