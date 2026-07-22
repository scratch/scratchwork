#!/usr/bin/env bun
/*
 * Prints the CHANGELOG.md section for one version to stdout — the release
 * workflow pipes it into the GitHub Release notes. Fails if the section is
 * missing, so a release can't ship with empty notes.
 *
 * Usage: bun scripts/release-notes.ts <x.y.z>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./workspaces";

const version = process.argv[2];
if (!version) {
  console.error("usage: bun scripts/release-notes.ts <x.y.z>");
  process.exit(1);
}
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.trim() === `## v${version}`);
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no "## v${version}" section — write one before releasing`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
console.log(lines.slice(start + 1, end).join("\n").trim());
