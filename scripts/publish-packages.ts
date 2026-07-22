#!/usr/bin/env bun
/*
 * Publishes the six packages to npm from their staged directories, in
 * dependency order (notes/distribution-plan.md Phase 4). Run locally with an
 * authenticated npm CLI after the GitHub Release exists (see RELEASING.md):
 *
 *   bun scripts/publish-packages.ts [--dry-run] [--otp <code>]
 *
 * With npm 2FA enabled, pass a fresh authenticator code via --otp (forwarded
 * to every npm publish; all six run within one code's validity window).
 *
 * Refuses to run on a dirty tree or when HEAD isn't the tag matching the
 * lockstep version, so what's published is exactly what's tagged. Uses
 * `npm publish --access public` (scoped packages default to restricted).
 * Moving this into release.yml with a granular NPM_TOKEN and --provenance is
 * a follow-up once the manual loop is boring.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAndStage } from "./build-packages";
import { repoRoot } from "./workspaces";

const dryRun = process.argv.includes("--dry-run");
const otpIndex = process.argv.indexOf("--otp");
const otp = otpIndex >= 0
  ? process.argv[otpIndex + 1]
  : process.argv.find((arg) => arg.startsWith("--otp="))?.slice("--otp=".length);
if (otpIndex >= 0 && !otp) {
  console.error("publish-packages: --otp requires a code");
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;

const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoRoot, stdout: "pipe" });
if (status.stdout.toString().trim() !== "") {
  console.error("publish-packages: working tree is dirty — publish only from a clean checkout of the release tag");
  process.exit(1);
}
const tags = Bun.spawnSync(["git", "tag", "--points-at", "HEAD"], { cwd: repoRoot, stdout: "pipe" });
const expected = `v${version}`;
if (!tags.stdout.toString().split("\n").map((tag) => tag.trim()).includes(expected)) {
  console.error(`publish-packages: HEAD is not tagged ${expected} — tag the release first (see RELEASING.md)`);
  process.exit(1);
}

const staged = buildAndStage();
for (const stagingDir of staged) {
  const name = JSON.parse(readFileSync(join(stagingDir, "package.json"), "utf8")).name as string;
  const args = [
    "npm",
    "publish",
    "--access",
    "public",
    ...(dryRun ? ["--dry-run"] : []),
    ...(otp ? [`--otp=${otp}`] : []),
  ];
  console.log(`\n${name}@${version}: ${args.join(" ")}`);
  const publish = Bun.spawnSync(args, { cwd: stagingDir, stdout: "inherit", stderr: "inherit" });
  if (!publish.success) {
    console.error(`publish-packages: publish failed for ${name} — packages published before it remain live`);
    process.exit(1);
  }
}
console.log(`\npublished ${staged.length} packages at ${version}${dryRun ? " (dry run)" : ""}`);
