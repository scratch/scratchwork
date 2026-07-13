#!/usr/bin/env bun
/*
 * e2e test runner: bundles the CLI once (each lane spawns it many times), then
 * runs every test file in its own `bun test` process, concurrently, with a
 * disjoint port range per file. Backend boots dominate the wall clock, so the
 * lanes running side by side cuts ci time to the slowest lane.
 *
 * Direct `bun test <file>` still works (the harness falls back to the CLI
 * source entry and the default port range).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, runPooled } from "../../scripts/pool";

const testDir = dirname(fileURLToPath(import.meta.url));
const e2eDir = dirname(testDir);
const repoRoot = dirname(e2eDir);

const bundle = join(testDir, ".build", "cli.js");
const bundled = Bun.spawnSync(
  ["bun", "build", join(repoRoot, "cli", "src", "index.ts"), "--target=bun", `--outfile=${bundle}`],
  { cwd: join(repoRoot, "cli"), stdout: "pipe", stderr: "pipe" },
);
if (!bundled.success) {
  console.error(`failed to bundle the CLI for e2e tests:\n${bundled.stderr.toString()}`);
  process.exit(1);
}

const files = readdirSync(testDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

const pool = createPool();

const run = (file: string, index: number) =>
  runPooled(pool, ["bun", "test", join(testDir, file)], {
    cwd: e2eDir,
    env: {
      ...process.env,
      SCRATCHWORK_E2E_CLI: bundle,
      SCRATCHWORK_E2E_PORT_BASE: String(35100 + index * 300),
    },
    title: file,
  });

const results = await Promise.all(files.map(run));
const failed = files.filter((_, index) => !results[index]);
if (failed.length > 0) {
  console.error(`\ne2e tests failed in: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ne2e tests passed: ${files.join(", ")}`);
