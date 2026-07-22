#!/usr/bin/env bun
/*
 * Mechanized dry-run of npm publishing (notes/distribution-plan.md Phase 4),
 * run inside the root `bun run ci`. No network.
 *
 *   1. Build + stage every publishable package (scripts/build-packages.ts)
 *      and `bun pm pack` each staged directory.
 *   2. Assert tarball shape: dist JS + matching d.ts, README, LICENSE; a
 *      manifest with no workspace:/private/scripts/devDependencies, every
 *      exports target present in the tarball, and the lockstep version.
 *   3. Assemble a consumer node_modules from the packed tarballs (external
 *      deps symlinked from the repo's node_modules, standing in for a
 *      registry install) and import every package's entrypoint under plain
 *      Node — except deploy-local, which requires Bun at runtime and is
 *      imported under Bun instead.
 *   4. Typecheck a tiny consumer under NodeNext resolution against the
 *      shipped declarations — the strictest consumer tsc configuration.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndStage } from "./build-packages";
import { repoRoot } from "./workspaces";

const failures: string[] = [];
const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;

const staged = buildAndStage();

interface PackedPackage {
  readonly name: string;
  readonly stagingDir: string;
  readonly tarball: string;
  readonly entries: readonly string[];
  readonly manifest: Record<string, unknown>;
}

function pack(stagingDir: string): PackedPackage | null {
  const packed = Bun.spawnSync(["bun", "pm", "pack"], { cwd: stagingDir, stdout: "pipe", stderr: "pipe" });
  if (!packed.success) {
    failures.push(`bun pm pack failed in ${stagingDir}:\n${packed.stderr.toString()}`);
    return null;
  }
  const tarballName = readdirSync(stagingDir).find((file) => file.endsWith(".tgz"));
  if (tarballName == null) {
    failures.push(`bun pm pack produced no tarball in ${stagingDir}`);
    return null;
  }
  const tarball = join(stagingDir, tarballName);
  const list = Bun.spawnSync(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "pipe" });
  const entries = list.stdout.toString().trim().split("\n");
  const manifestText = Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"], { stdout: "pipe" });
  const manifest = JSON.parse(manifestText.stdout.toString());
  return { name: manifest.name, stagingDir, tarball, entries, manifest };
}

function checkTarball(pkg: PackedPackage): void {
  const { name, entries, manifest } = pkg;
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"]) {
    if (!entries.includes(required)) failures.push(`${name}: tarball is missing ${required}`);
  }
  const jsFiles = entries.filter((entry) => entry.startsWith("package/dist/") && entry.endsWith(".js"));
  if (jsFiles.length === 0) failures.push(`${name}: tarball has no built JS under dist/`);
  for (const js of jsFiles) {
    const declaration = js.slice(0, -3) + ".d.ts";
    if (!entries.includes(declaration)) failures.push(`${name}: ${js} has no matching ${declaration}`);
  }
  const offenders = entries.filter((entry) => /\.test\.|\/test\/|\.ts$/.test(entry) && !entry.endsWith(".d.ts"));
  if (offenders.length > 0) failures.push(`${name}: tarball ships test or source files: ${offenders.join(", ")}`);

  const raw = JSON.stringify(manifest);
  if (raw.includes("workspace:")) failures.push(`${name}: manifest still contains workspace: ranges`);
  for (const field of ["private", "scripts", "devDependencies"]) {
    if (field in manifest) failures.push(`${name}: manifest ships dev-only field "${field}"`);
  }
  if (manifest.version !== rootVersion) failures.push(`${name}: version ${manifest.version} != lockstep ${rootVersion}`);
  if (manifest.license !== "MIT" || manifest.repository == null) failures.push(`${name}: missing license/repository metadata`);
  for (const [subpath, target] of Object.entries(manifest.exports as Record<string, { types: string; default: string }>)) {
    for (const kind of ["types", "default"] as const) {
      const file = target[kind];
      // Pattern exports are spot-checked by the import smoke below instead.
      if (file.includes("*")) continue;
      if (!entries.includes(`package/${file.slice(2)}`)) {
        failures.push(`${name}: exports["${subpath}"].${kind} points at ${file}, which is not in the tarball`);
      }
    }
  }
}

/** Lays out a consumer install: tarballs extracted into node_modules/@scratchwork,
 * every other dependency symlinked from the repo root's node_modules. */
function assembleConsumer(packages: readonly PackedPackage[]): string {
  const consumer = mkdtempSync(join(tmpdir(), "scratchwork-consumer-"));
  const nodeModules = join(consumer, "node_modules");
  mkdirSync(join(nodeModules, "@scratchwork"), { recursive: true });
  for (const entry of readdirSync(join(repoRoot, "node_modules"))) {
    if (entry === "@scratchwork" || entry.startsWith(".")) continue;
    symlinkSync(join(repoRoot, "node_modules", entry), join(nodeModules, entry));
  }
  for (const pkg of packages) {
    const extractDir = join(consumer, "extract", pkg.name);
    mkdirSync(extractDir, { recursive: true });
    const untar = Bun.spawnSync(["tar", "-xzf", pkg.tarball, "-C", extractDir]);
    if (!untar.success) {
      failures.push(`${pkg.name}: could not extract ${pkg.tarball}`);
      continue;
    }
    cpSync(join(extractDir, "package"), join(nodeModules, pkg.name), { recursive: true });
  }
  rmSync(join(consumer, "extract"), { recursive: true, force: true });
  return consumer;
}

function importSmoke(consumer: string, runtime: "node" | "bun", specifier: string): void {
  const result = Bun.spawnSync(
    [runtime, "--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`].filter(
      (arg) => runtime === "node" || arg !== "--input-type=module",
    ),
    { cwd: consumer, stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success) {
    failures.push(`${specifier}: import under ${runtime} failed:\n${result.stderr.toString().slice(0, 2000)}`);
  }
}

const packages = staged.map(pack).filter((pkg): pkg is PackedPackage => pkg != null);
for (const pkg of packages) checkTarball(pkg);

if (failures.length === 0) {
  const consumer = assembleConsumer(packages);
  importSmoke(consumer, "node", "@scratchwork/shared/publish/api");
  importSmoke(consumer, "node", "@scratchwork/shared/site/serve");
  importSmoke(consumer, "node", "@scratchwork/server-core");
  importSmoke(consumer, "node", "@scratchwork/server-core/deploy/server-settings");
  importSmoke(consumer, "node", "@scratchwork/server-deploy-aws");
  importSmoke(consumer, "node", "@scratchwork/server-deploy-cloudflare");
  importSmoke(consumer, "bun", "@scratchwork/server-deploy-local");

  // Consumer typecheck under NodeNext — the strictest resolution a user runs.
  writeFileSync(
    join(consumer, "consumer.ts"),
    [
      'import { ScratchworkApi } from "@scratchwork/shared/publish/api";',
      'import { contentType } from "@scratchwork/shared/site/content";',
      'import type { ScratchworkServerConfig } from "@scratchwork/server-core/deploy/server-settings";',
      'import { deployServer } from "@scratchwork/server-deploy-cloudflare";',
      "const config: ScratchworkServerConfig = { auth: \"oauth\", appDomain: \"app.example.com\" };",
      "void ScratchworkApi; void contentType; void deployServer; void config;",
      "",
    ].join("\n"),
  );
  const tsc = Bun.spawnSync(
    [
      "bunx", "tsc", "--noEmit", "--strict", "--skipLibCheck",
      "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "esnext",
      join(consumer, "consumer.ts"),
    ],
    { cwd: consumer, stdout: "pipe", stderr: "pipe" },
  );
  if (!tsc.success) {
    failures.push(`consumer typecheck under NodeNext failed:\n${tsc.stdout.toString().slice(0, 2000)}`);
  }
  rmSync(consumer, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check-npm-pack: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}
console.log(
  `check-npm-pack: ${packages.length} tarballs verified (shape, manifest, Node/Bun import smoke, NodeNext consumer typecheck)`,
);
