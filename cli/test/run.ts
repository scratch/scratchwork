#!/usr/bin/env bun
/*
 * cli test runner: prepares shared build artifacts once, then runs every test
 * file in its own `bun test` process, concurrently. `bun test` is serial
 * within a process, and the e2e suite's ~60 CLI spawns dominate the cli
 * workspace's ci time — this cuts the wall clock to the slowest single file.
 *
 * Direct `bun test [file]` still works (helpers fall back to the source entry
 * and the default port range); this runner is just the fast path package.json
 * wires into `bun run test`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rendererSourceHash } from "../../renderer/build.js";
import { createPool, runPooled } from "../../scripts/pool";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = dirname(testDir);
const rendererDir = join(cliDir, "..", "renderer");

// 1. The embedded-fallback tests read renderer/dist/index.html. Ensure both it
//    and the generated module match the current sources before starting any
//    parallel processes, so they never race to refresh stale artifacts.
const rendererHtml = join(rendererDir, "dist", "index.html");
const generatedRenderer = join(
  cliDir,
  "..",
  "shared",
  "src",
  "site",
  "default-renderer.generated.js",
);
let generatedSourceHash: string | null = null;
try {
  const match = readFileSync(generatedRenderer, "utf8").match(
    /^export const defaultRendererSourceHash = "([a-f0-9]+)";/m,
  );
  generatedSourceHash = match?.[1] ?? null;
} catch {
  // A missing generated module is handled by the rebuild below.
}

if (!existsSync(rendererHtml) || generatedSourceHash !== rendererSourceHash()) {
  const built = Bun.spawnSync(["bun", "build.js"], { cwd: rendererDir, stdout: "pipe", stderr: "pipe" });
  if (!built.success) {
    console.error(`failed to build renderer shell:\n${built.stderr.toString()}`);
    process.exit(1);
  }
}

// 2. Bundle the CLI once so every e2e spawn skips re-transpiling the Effect
//    dependency graph (~150ms locally, ~700ms on CI runners, × ~60 spawns).
//    test/.build sits at the same depth as src/renderer, so the bundle
//    resolves ../../../renderer exactly like source runs do (default.ts).
const bundle = join(testDir, ".build", "cli.js");
const bundled = Bun.spawnSync(
  ["bun", "build", join(cliDir, "src", "index.ts"), "--target=bun", `--outfile=${bundle}`],
  { cwd: cliDir, stdout: "pipe", stderr: "pipe" },
);
if (!bundled.success) {
  console.error(`failed to bundle the CLI for tests:\n${bundled.stderr.toString()}`);
  process.exit(1);
}

// 3. One `bun test` process per file, CPU-bounded, each with a disjoint port
//    range. Output is buffered per file so logs never interleave; every file
//    runs even if another fails.
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js") || f.endsWith(".test.ts"))
  .sort();

const pool = createPool();

const run = (file: string, index: number) =>
  runPooled(pool, ["bun", "test", join(testDir, file)], {
    cwd: cliDir,
    env: {
      ...process.env,
      SCRATCHWORK_E2E_CLI: bundle,
      SCRATCHWORK_E2E_PORT_BASE: String(34100 + index * 300),
    },
    title: file,
  });

const results = await Promise.all(files.map(run));
const failed = files.filter((_, i) => !results[i]);
if (failed.length > 0) {
  console.error(`\ncli tests failed in: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ncli tests passed: ${files.join(", ")}`);
