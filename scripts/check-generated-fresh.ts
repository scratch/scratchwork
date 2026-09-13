#!/usr/bin/env bun
/*
 * Fails if any tracked generated artifact differs from what the workspace ci
 * runs just rebuilt. Runs at the end of the root `bun run ci`, after the
 * renderer and cli builds have regenerated every artifact — so a stale commit
 * (renderer sources changed without re-running the build) fails the gate
 * instead of shipping an old embedded renderer.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Every generated file committed to the repo. dist/ outputs are gitignored
// and don't belong here.
const artifacts = [
  "shared/src/site/default-renderer.generated.js",
  "shared/src/assets/figure-svg.generated.ts",
  "server/core/src/comments-widget.generated.ts",
];

const status = Bun.spawnSync(
  ["git", "status", "--porcelain", "--", ...artifacts],
  { cwd: root },
);
if (!status.success) {
  console.error("check-generated-fresh: git status failed");
  process.exit(1);
}
const dirty = status.stdout.toString().trim();
if (dirty) {
  console.error("Generated artifacts are stale — the ci rebuild changed them:\n");
  console.error(dirty + "\n");
  Bun.spawnSync(["git", "--no-pager", "diff", "--stat", "--", ...artifacts], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  console.error("\nCommit the regenerated files (they are rebuilt by `bun run ci`).");
  process.exit(1);
}
console.log(`generated artifacts fresh: ${artifacts.join(", ")}`);
