#!/usr/bin/env bun
/*
 * Mechanized checks for scratchwork.dev/www/install.sh and the CLI's
 * self-install commands (`scratchwork install` / `scratchwork update`), run
 * inside the root `bun run ci`:
 *
 *   1. `sh -n` syntax check.
 *   2. A local HTTP fixture stands in for GitHub Releases (no network).
 *      install.sh downloads, checksum-verifies, and extracts, then delegates
 *      to the binary's own `install` command, so the end-to-end cases run the
 *      real compiled binary (cli/dist/scratchwork, built by the cli
 *      workspace's ci earlier in the gate; built here when missing):
 *      latest install via install.sh, then `scratchwork update` self-replace,
 *      already-up-to-date, and checksum-rejection.
 *   3. sh-only behavior — pinned versions, checksum rejection, and
 *      uname→target platform mapping via a fake `uname` on PATH — uses tiny
 *      fake sh "binaries" that answer any invocation, keeping those cases fast.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./workspaces";

const script = join(repoRoot, "scratchwork.dev", "www", "install.sh");
const failures: string[] = [];

// ── 1. Syntax ───────────────────────────────────────────────────────────────
const syntax = Bun.spawnSync(["sh", "-n", script], { stderr: "pipe" });
if (!syntax.success) {
  failures.push(`sh -n scratchwork.dev/www/install.sh failed:\n${syntax.stderr.toString()}`);
}

// ── 2. Hermetic fixture ─────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "install-sh-check-"));
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const HOST_TARGET = `${process.platform}-${process.arch}`;

// The real compiled binary: the end-to-end cases exercise its `install` and
// `update` commands, not a stand-in.
const realBinary = join(repoRoot, "cli", "dist", "scratchwork");
if (!existsSync(realBinary)) {
  const build = Bun.spawnSync(["bun", "build.js"], { cwd: join(repoRoot, "cli"), stdout: "inherit", stderr: "inherit" });
  if (!build.success) {
    console.error("check-install-sh: failed to build cli/dist/scratchwork");
    process.exit(1);
  }
}
const realVersion = Bun.spawnSync([realBinary, "version"], { stdout: "pipe" }).stdout.toString().trim();
if (!/^\d+\.\d+\.\d+/.test(realVersion)) {
  console.error(`check-install-sh: cli/dist/scratchwork did not report a version (got "${realVersion}")`);
  process.exit(1);
}

// Tar the real binary once; releases that carry it copy this archive.
const realTarball = join(work, "scratchwork-host.tar.gz");
{
  const staging = join(work, "staging-host");
  mkdirSync(staging);
  cpSync(realBinary, join(staging, "scratchwork"));
  chmodSync(join(staging, "scratchwork"), 0o755);
  const tar = Bun.spawnSync(["tar", "-czf", realTarball, "-C", staging, "scratchwork"]);
  if (!tar.success) throw new Error("fixture tar failed for the real binary");
}

/**
 * Builds a fake release: per-target tarballs plus checksums.txt. Non-host
 * targets (and everything, without `realHost`) are tiny sh "binaries" that
 * answer any invocation — enough for the sh-only cases. With `realHost`, the
 * host target's asset is the real compiled binary.
 */
function makeRelease(version: string, options: { realHost?: boolean } = {}): { dir: string } {
  const dir = join(work, `release-v${version}`);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const target of TARGETS) {
    const archive = join(dir, `scratchwork-v${version}-${target}.tar.gz`);
    if (options.realHost && target === HOST_TARGET) {
      cpSync(realTarball, archive);
    } else {
      const staging = join(dir, `staging-${target}`);
      mkdirSync(staging);
      writeFileSync(join(staging, "scratchwork"), `#!/bin/sh\necho "${version} (${target})"\n`);
      chmodSync(join(staging, "scratchwork"), 0o755);
      const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", staging, "scratchwork"]);
      if (!tar.success) throw new Error(`fixture tar failed for ${archive}`);
    }
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
    lines.push(`${digest}  scratchwork-v${version}-${target}.tar.gz`);
  }
  writeFileSync(join(dir, "checksums.txt"), lines.join("\n") + "\n");
  return { dir };
}

const releases: Record<string, { dir: string }> = {
  "9.9.9": makeRelease("9.9.9", { realHost: true }),
  "8.8.8": makeRelease("8.8.8"),
  [realVersion]: makeRelease(realVersion, { realHost: true }),
};

let latestVersion = "9.9.9";
let tamperChecksums = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    const latestMatch = path === "/latest/download/checksums.txt";
    const versioned = path.match(/^\/download\/v([^/]+)\/(.+)$/);
    const version = latestMatch ? latestVersion : versioned?.[1];
    const file = latestMatch ? "checksums.txt" : versioned?.[2];
    const release = version != null ? releases[version] : undefined;
    if (release == null || file == null) return new Response("not found", { status: 404 });
    if (file === "checksums.txt" && tamperChecksums) {
      const tampered = readFileSync(join(release.dir, file), "utf8").replace(/^[0-9a-f]{8}/gm, "00000000");
      return new Response(tampered);
    }
    return new Response(Bun.file(join(release.dir, file)));
  },
});
const base = `http://127.0.0.1:${server.port}`;

// A fake uname for platform-mapping cases; real uname answers otherwise.
const fakeBin = join(work, "fake-bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "uname"),
  `#!/bin/sh\ncase "\${1:-}" in\n  -s) echo "$FAKE_UNAME_S" ;;\n  -m) echo "$FAKE_UNAME_M" ;;\n  *) echo "Fake" ;;\nesac\n`,
);
chmodSync(join(fakeBin, "uname"), 0o755);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Async spawn is load-bearing: the install script and the update command curl
// the Bun.serve fixture in this same process, and spawnSync would block the
// event loop that serves it.
async function run(cmd: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    env: { HOME: work, SCRATCHWORK_DOWNLOAD_BASE: base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

let caseNumber = 0;
async function runInstall(env: Record<string, string>): Promise<RunResult & { installDir: string }> {
  const installDir = join(work, `install-${caseNumber++}`);
  const result = await run(["sh", script], {
    PATH: env.FAKE_UNAME_S ? `${fakeBin}:${process.env.PATH}` : process.env.PATH,
    SCRATCHWORK_INSTALL_DIR: installDir,
    ...env,
  });
  return { ...result, installDir };
}

function expect(name: string, condition: boolean, detail: RunResult) {
  if (!condition) {
    failures.push(`${name}\n  exit=${detail.code}\n  stdout: ${detail.stdout.trim()}\n  stderr: ${detail.stderr.trim()}`);
  }
}

// ── End-to-end: install.sh → real binary's `scratchwork install` ────────────
const latestRun = await runInstall({});
expect(
  "latest install should run the real binary's install command end-to-end",
  latestRun.code === 0 &&
    latestRun.stdout.includes("Downloading scratchwork v9.9.9") &&
    latestRun.stdout.includes(`Installed ${join(latestRun.installDir, "scratchwork")}`) &&
    latestRun.stdout.includes(`scratchwork ${realVersion} is ready.`) &&
    latestRun.stdout.includes("is not on your PATH") &&
    existsSync(join(latestRun.installDir, "scratchwork")),
  latestRun,
);

// ── End-to-end: `scratchwork update` against the fixture ────────────────────
const updateHome = join(work, "update-home");
mkdirSync(updateHome);
const updateBinary = join(updateHome, "scratchwork");
cpSync(realBinary, updateBinary);
chmodSync(updateBinary, 0o755);

// Success: self-replace with the fixture's latest (a fresh inode proves the swap).
const inodeBefore = statSync(updateBinary).ino;
let result = await run([updateBinary, "update"], { PATH: process.env.PATH });
expect(
  "update should download, verify, and replace the running binary",
  result.code === 0 &&
    result.stdout.includes("Downloading scratchwork v9.9.9") &&
    result.stdout.includes(`-> 9.9.9`) &&
    statSync(updateBinary).ino !== inodeBefore,
  result,
);

// Already up to date: the fixture's latest matches the binary's own version.
latestVersion = realVersion;
result = await run([updateBinary, "update"], { PATH: process.env.PATH });
expect(
  "update should be a no-op when already on the latest version",
  result.code === 0 && result.stdout.includes("already the latest version") && !result.stdout.includes("Downloading"),
  result,
);
latestVersion = "9.9.9";

// Tampered checksums must be rejected by the update command.
tamperChecksums = true;
result = await run([updateBinary, "update"], { PATH: process.env.PATH });
expect(
  "update must reject tampered checksums",
  result.code !== 0 && result.stderr.includes("checksum mismatch"),
  result,
);
tamperChecksums = false;

// ── sh-only behavior (fake binaries; nothing real gets executed) ────────────
// Pinned version install.
result = await runInstall({ SCRATCHWORK_VERSION: "8.8.8" });
expect("pinned install should fetch v8.8.8", result.code === 0 && result.stdout.includes("8.8.8"), result);

// Checksum tampering must be rejected before anything runs.
tamperChecksums = true;
result = await runInstall({});
expect("tampered checksums must fail with a mismatch", result.code !== 0 && result.stderr.includes("checksum mismatch"), result);
tamperChecksums = false;

// Platform mapping: unsupported OS and architecture fail with clear errors...
result = await runInstall({ FAKE_UNAME_S: "FreeBSD", FAKE_UNAME_M: "x86_64" });
expect("unsupported OS must fail before downloading", result.code !== 0 && result.stderr.includes("unsupported operating system"), result);
result = await runInstall({ FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "riscv64" });
expect("unsupported architecture must fail", result.code !== 0 && result.stderr.includes("unsupported architecture"), result);

// ...and supported uname spellings map to the right release asset. Pinned to
// the all-fake release so a non-host asset never runs for real.
result = await runInstall({ SCRATCHWORK_VERSION: "8.8.8", FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "aarch64" });
expect("Linux/aarch64 must map to the linux-arm64 asset", result.code === 0 && result.stdout.includes("(linux-arm64)"), result);
result = await runInstall({ SCRATCHWORK_VERSION: "8.8.8", FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64" });
expect("Darwin/arm64 must map to the darwin-arm64 asset", result.code === 0 && result.stdout.includes("(darwin-arm64)"), result);

server.stop(true);
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`check-install-sh: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}
console.log(
  "check-install-sh: syntax ok; end-to-end install + update (real binary) and pinned, checksum-rejection, platform-mapping cases pass against the local fixture",
);
