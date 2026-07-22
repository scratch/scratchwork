#!/usr/bin/env bun
/*
 * Mechanizes the lockstep-version rule (notes/distribution-plan.md decision 1):
 * every workspace package.json carries exactly the root version. A drifted
 * bump fails the gate; bump with `bun scripts/set-version.ts <x.y.z>`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, workspaceDirs } from "./workspaces";

const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
const drifted: string[] = [];
const dirs = workspaceDirs();
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
  if (pkg.version !== rootVersion) drifted.push(`${dir}: ${pkg.version}`);
}
if (drifted.length > 0) {
  console.error(`check-versions: root is ${rootVersion} but these workspaces drifted:\n`);
  for (const line of drifted) console.error(`  ${line}`);
  console.error("\nStamp them back into lockstep with `bun scripts/set-version.ts <x.y.z>`.");
  process.exit(1);
}
console.log(`check-versions: root and all ${dirs.length} workspaces at ${rootVersion}`);
