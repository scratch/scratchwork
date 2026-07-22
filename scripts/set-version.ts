#!/usr/bin/env bun
/*
 * Stamps the lockstep version into the root package.json and every workspace
 * package.json. One version for the whole repo (see notes/distribution-plan.md
 * decision 1): CLI binaries and all npm packages share it, and the git tag
 * vX.Y.Z on main is the release trigger. This script's only duty is stamping —
 * tagging and CHANGELOG.md stay manual and visible (see RELEASING.md).
 *
 * Usage: bun scripts/set-version.ts <x.y.z>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, workspaceDirs } from "./workspaces";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun scripts/set-version.ts <x.y.z>");
  process.exit(1);
}

const manifests = ["", ...workspaceDirs()].map((dir) => join(repoRoot, dir, "package.json"));
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const previous = pkg.version;
  pkg.version = version;
  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${manifest.slice(repoRoot.length + 1)}: ${previous} -> ${version}`);
}
console.log(`\nstamped ${manifests.length} manifests to ${version}`);
