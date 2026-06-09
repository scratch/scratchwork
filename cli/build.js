#!/usr/bin/env bun
/*
 * Build the CLI into a standalone binary: cli/dist/scratchwork.
 *
 *   1. Build the renderer (template/dist/index.html + template/dist/shell.js).
 *   2. `bun build --compile` scratchwork.js into a single self-contained executable.
 *      scratchwork.js imports ../template/dist/shell.js (a literal dynamic import),
 *      which the compiler embeds into the binary — so it runs anywhere, with no
 *      renderer source or dist on disk.
 *
 * Requires the renderer's deps to be installed (cd ../template && bun install).
 */
import { buildDist } from "../template/build.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "dist");
const OUT_BIN = join(OUT_DIR, "scratchwork");

// 1. Build the renderer shell the binary will embed.
await buildDist();

// 2. Compile scratchwork.js (which imports ../template/dist/shell.js) into a binary.
mkdirSync(OUT_DIR, { recursive: true });
const proc = Bun.spawnSync(
  ["bun", "build", join(here, "scratchwork.js"), "--compile", "--outfile", OUT_BIN],
  { cwd: here, stdout: "inherit", stderr: "inherit" },
);
if (!proc.success) {
  console.error("cli build: `bun build --compile` failed");
  process.exit(1);
}
console.log(`Built cli/dist/scratchwork (standalone binary, renderer shell embedded)`);
