#!/usr/bin/env bun
/*
 * Build the CLI into a standalone binary: cli/dist/scratchwork.
 *
 *   1. Build the renderer (renderer/dist/* + shared generated renderer module).
 *   2. `bun build --compile` src/index.ts into a single self-contained executable.
 *      src/renderer/default.ts imports the generated shared module, which the
 *      compiler embeds into the binary, so it runs anywhere with no renderer
 *      source or dist on disk.
 *
 * With --all-targets, cross-compiles the release target matrix instead
 * (decision 4 in notes/distribution-plan.md) into cli/dist/scratchwork-<os>-<arch>.
 * The default (no flag) build is unchanged so `bun run ci` cost stays the same.
 *
 * Requires the renderer's deps to be installed (cd ../renderer && bun install).
 */
import { buildDist } from "../renderer/build.js";
import { RELEASE_TARGETS } from "../scripts/release-targets";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "dist");

// 1. Build the renderer shell the binary will embed through shared/src/site.
await buildDist();

// 2. Compile src/index.ts — host binary by default, the matrix with --all-targets.
mkdirSync(OUT_DIR, { recursive: true });
const builds = process.argv.includes("--all-targets")
  ? RELEASE_TARGETS.map((target) => ({
      outfile: join(OUT_DIR, `scratchwork-${target}`),
      extraArgs: [`--target=bun-${target}`],
    }))
  : [{ outfile: join(OUT_DIR, "scratchwork"), extraArgs: [] }];

for (const { outfile, extraArgs } of builds) {
  const proc = Bun.spawnSync(
    ["bun", "build", join(here, "src", "index.ts"), "--compile", ...extraArgs, "--outfile", outfile],
    { cwd: here, stdout: "inherit", stderr: "inherit" },
  );
  if (!proc.success) {
    console.error(`cli build: \`bun build --compile ${extraArgs.join(" ")}\` failed`);
    process.exit(1);
  }
  console.log(`Built ${outfile.slice(dirname(here).length + 1)} (standalone binary, renderer shell embedded)`);
}
