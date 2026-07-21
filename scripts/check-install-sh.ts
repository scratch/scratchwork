#!/usr/bin/env bun
/*
 * Mechanized checks for docs/install.sh (notes/distribution-plan.md Phase 3),
 * run inside the root `bun run ci`:
 *
 *   1. `sh -n` syntax check.
 *   2. Full install loop against a local HTTP fixture standing in for GitHub
 *      Releases (no network): latest install, pinned-version install,
 *      checksum-mismatch rejection, and uname→target platform mapping via a
 *      fake `uname` on PATH. The "binaries" are tiny sh scripts that answer
 *      `--version`, so the loop exercises download → verify → extract →
 *      install → run without real release assets.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./workspaces";

const script = join(repoRoot, "docs", "install.sh");
const failures: string[] = [];

// ── 1. Syntax ───────────────────────────────────────────────────────────────
const syntax = Bun.spawnSync(["sh", "-n", script], { stderr: "pipe" });
if (!syntax.success) {
  failures.push(`sh -n docs/install.sh failed:\n${syntax.stderr.toString()}`);
}

// ── 2. Hermetic fixture ─────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "install-sh-check-"));
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

/** Builds a fake release: per-target tarballs of an sh "binary" + checksums.txt. */
function makeRelease(version: string): { dir: string; checksums: string } {
  const dir = join(work, `release-v${version}`);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const target of TARGETS) {
    const staging = join(dir, `staging-${target}`);
    mkdirSync(staging);
    writeFileSync(join(staging, "scratchwork"), `#!/bin/sh\necho "${version} (${target})"\n`);
    chmodSync(join(staging, "scratchwork"), 0o755);
    const archive = join(dir, `scratchwork-v${version}-${target}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", staging, "scratchwork"]);
    if (!tar.success) throw new Error(`fixture tar failed for ${archive}`);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
    lines.push(`${digest}  scratchwork-v${version}-${target}.tar.gz`);
  }
  const checksums = lines.join("\n") + "\n";
  writeFileSync(join(dir, "checksums.txt"), checksums);
  return { dir, checksums };
}

const latest = makeRelease("9.9.9");
const pinned = makeRelease("8.8.8");
const releases: Record<string, { dir: string }> = { "9.9.9": latest, "8.8.8": pinned };

let tamperChecksums = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    const latestMatch = path === "/latest/download/checksums.txt";
    const versioned = path.match(/^\/download\/v([^/]+)\/(.+)$/);
    const version = latestMatch ? "9.9.9" : versioned?.[1];
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

let caseNumber = 0;
// Async spawn is load-bearing: the install script curls the Bun.serve fixture in
// this same process, and spawnSync would block the event loop that serves it.
async function runInstall(env: Record<string, string>): Promise<RunResult> {
  const installDir = join(work, `install-${caseNumber++}`);
  const proc = Bun.spawn(["sh", script], {
    env: {
      PATH: env.FAKE_UNAME_S ? `${fakeBin}:${process.env.PATH}` : process.env.PATH,
      HOME: work,
      SCRATCHWORK_DOWNLOAD_BASE: base,
      SCRATCHWORK_INSTALL_DIR: installDir,
      ...env,
    },
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

function expect(name: string, condition: boolean, detail: RunResult) {
  if (!condition) {
    failures.push(`${name}\n  exit=${detail.code}\n  stdout: ${detail.stdout.trim()}\n  stderr: ${detail.stderr.trim()}`);
  }
}

// Latest install on the real host platform.
let result = await runInstall({});
expect("latest install should succeed and run the binary", result.code === 0 && result.stdout.includes("9.9.9"), result);

// Pinned version install.
result = await runInstall({ SCRATCHWORK_VERSION: "8.8.8" });
expect("pinned install should fetch v8.8.8", result.code === 0 && result.stdout.includes("8.8.8"), result);

// Checksum tampering must be rejected.
tamperChecksums = true;
result = await runInstall({});
expect("tampered checksums must fail with a mismatch", result.code !== 0 && result.stderr.includes("checksum mismatch"), result);
tamperChecksums = false;

// Platform mapping: unsupported OS and architecture fail with clear errors...
result = await runInstall({ FAKE_UNAME_S: "FreeBSD", FAKE_UNAME_M: "x86_64" });
expect("unsupported OS must fail before downloading", result.code !== 0 && result.stderr.includes("unsupported operating system"), result);
result = await runInstall({ FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "riscv64" });
expect("unsupported architecture must fail", result.code !== 0 && result.stderr.includes("unsupported architecture"), result);

// ...and supported uname spellings map to the right release asset.
result = await runInstall({ FAKE_UNAME_S: "Linux", FAKE_UNAME_M: "aarch64" });
expect("Linux/aarch64 must map to the linux-arm64 asset", result.code === 0 && result.stdout.includes("(linux-arm64)"), result);
result = await runInstall({ FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64" });
expect("Darwin/arm64 must map to the darwin-arm64 asset", result.code === 0 && result.stdout.includes("(darwin-arm64)"), result);

server.stop(true);
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`check-install-sh: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}
console.log("check-install-sh: syntax ok; latest, pinned, checksum-rejection, and platform-mapping cases pass against the local fixture");
