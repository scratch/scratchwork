#!/usr/bin/env bun
/*
 * Build the CLI into a standalone binary: cli/dist/scratchwork.
 *
 *   1. Build the renderer (renderer/dist/* + shared generated renderer module).
 *   2. `bun build --compile` src/index.ts into a single self-contained executable.
 *      src/renderer/default.ts imports the generated shared module, which the
 *      compiler embeds into the binary, so it runs anywhere with no template
 *      source or dist on disk.
 *
 * Requires the renderer's deps to be installed (cd ../renderer && bun install).
 */
import { buildDist } from "../renderer/build.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "dist");
const OUT_BIN = join(OUT_DIR, "scratchwork");

// 1. Build the renderer shell the binary will embed through shared/src/site.
await buildDist();

// 2. Compile src/index.ts into a binary.
mkdirSync(OUT_DIR, { recursive: true });
const proc = Bun.spawnSync(
  ["bun", "build", join(here, "src", "index.ts"), "--compile", "--outfile", OUT_BIN],
  { cwd: here, stdout: "inherit", stderr: "inherit" },
);
if (!proc.success) {
  console.error("cli build: `bun build --compile` failed");
  process.exit(1);
}
console.log(`Built cli/dist/scratchwork (standalone binary, renderer shell embedded)`);
