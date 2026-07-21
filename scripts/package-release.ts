#!/usr/bin/env bun
/*
 * Packages the cross-compiled CLI binaries (cli/dist/scratchwork-<os>-<arch>,
 * built by `cd cli && bun build.js --all-targets`) into release/ at the repo
 * root:
 *
 *   scratchwork-v<version>-<os>-<arch>.tar.gz   one per target, containing a
 *                                               single file named `scratchwork`
 *   checksums.txt                               SHA-256 of each archive, in
 *                                               `sha256sum` format
 *
 * Tarball rather than bare binary so the executable bit survives and the name
 * inside is stable. checksums.txt is also how install.sh discovers the latest
 * version (its asset names carry the version), so its name stays unversioned.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./workspaces";
// RELEASE_TARGETS is exported by cli/build.js, but importing it would run the
// build; keep the list in scripts/release-targets.ts, shared by both.
import { RELEASE_TARGETS } from "./release-targets";

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
const releaseDir = join(repoRoot, "release");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

const checksums: string[] = [];
for (const target of RELEASE_TARGETS) {
  const binary = join(repoRoot, "cli", "dist", `scratchwork-${target}`);
  if (!existsSync(binary)) {
    console.error(`package-release: missing ${binary} — run \`cd cli && bun build.js --all-targets\` first`);
    process.exit(1);
  }
  const archiveName = `scratchwork-v${version}-${target}.tar.gz`;
  const staging = mkdtempSync(join(tmpdir(), "scratchwork-release-"));
  try {
    cpSync(binary, join(staging, "scratchwork"));
    chmodSync(join(staging, "scratchwork"), 0o755);
    const tar = Bun.spawnSync(
      ["tar", "-czf", join(releaseDir, archiveName), "-C", staging, "scratchwork"],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (!tar.success) {
      console.error(`package-release: tar failed for ${archiveName}`);
      process.exit(1);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(releaseDir, archiveName))).digest("hex");
  checksums.push(`${digest}  ${archiveName}`);
  console.log(`release/${archiveName}`);
}
writeFileSync(join(releaseDir, "checksums.txt"), checksums.join("\n") + "\n");
console.log(`release/checksums.txt (${checksums.length} archives, version ${version})`);
