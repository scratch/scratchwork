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
 *   5. Run the packed create-scratchwork-server bin under plain Node (what
 *      `npm create` uses) to scaffold every platform template into the
 *      consumer, then typecheck each scaffolded project — its pinned
 *      @scratchwork/* deps resolve to the packed tarballs, so the templates
 *      are verified against exactly what ships, without the network.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_SOURCES } from "../create/generate-templates";
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
  // templates/ deliberately ships .ts sources: they are the scaffolded
  // project's own files, not this package's code.
  const offenders = entries.filter(
    (entry) => /\.test\.|\/test\/|\.ts$/.test(entry) && !entry.endsWith(".d.ts") && !entry.startsWith("package/templates/"),
  );
  if (offenders.length > 0) failures.push(`${name}: tarball ships test or source files: ${offenders.join(", ")}`);

  const raw = JSON.stringify(manifest);
  if (raw.includes("workspace:")) failures.push(`${name}: manifest still contains workspace: ranges`);
  for (const field of ["private", "scripts", "devDependencies"]) {
    if (field in manifest) failures.push(`${name}: manifest ships dev-only field "${field}"`);
  }
  if (manifest.version !== rootVersion) failures.push(`${name}: version ${manifest.version} != lockstep ${rootVersion}`);
  if (manifest.license !== "MIT" || manifest.repository == null) failures.push(`${name}: missing license/repository metadata`);
  if (manifest.exports == null && manifest.bin == null) failures.push(`${name}: manifest has neither exports nor bin`);
  for (const [subpath, target] of Object.entries((manifest.exports ?? {}) as Record<string, { types: string; default: string }>)) {
    for (const kind of ["types", "default"] as const) {
      const file = target[kind];
      // Pattern exports are spot-checked by the import smoke below instead.
      if (file.includes("*")) continue;
      if (!entries.includes(`package/${file.slice(2)}`)) {
        failures.push(`${name}: exports["${subpath}"].${kind} points at ${file}, which is not in the tarball`);
      }
    }
  }
  for (const [binName, file] of Object.entries((manifest.bin ?? {}) as Record<string, string>)) {
    if (!entries.includes(`package/${file.slice(2)}`)) {
      failures.push(`${name}: bin["${binName}"] points at ${file}, which is not in the tarball`);
    }
  }
}

/** Lays out a consumer install: tarballs extracted into node_modules,
 * every other dependency symlinked from the repo root's node_modules. */
function assembleConsumer(packages: readonly PackedPackage[]): string {
  const consumer = mkdtempSync(join(tmpdir(), "scratchwork-consumer-"));
  const nodeModules = join(consumer, "node_modules");
  mkdirSync(join(nodeModules, "@scratchwork"), { recursive: true });
  // Never symlink a package that the tarballs provide: the repo's
  // node_modules entry for it is a workspace symlink, and copying the
  // extracted tarball through that symlink would overwrite the workspace
  // source (this bit create-scratchwork-server once).
  const packedNames = new Set(packages.map((pkg) => pkg.name));
  for (const entry of readdirSync(join(repoRoot, "node_modules"))) {
    if (entry === "@scratchwork" || entry.startsWith(".") || packedNames.has(entry)) continue;
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

  // Scaffold every create-scratchwork-server template with the packed bin
  // under plain Node (npm create's runtime) and typecheck the result — the
  // scaffolded @scratchwork/* deps resolve to the packed tarballs already
  // installed in the consumer's node_modules.
  const createPackage = join(consumer, "node_modules", "create-scratchwork-server");
  const packedPlatforms = existsSync(join(createPackage, "templates"))
    ? readdirSync(join(createPackage, "templates"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const expectedPlatforms = Object.keys(TEMPLATE_SOURCES).sort();
  if (packedPlatforms.join(",") !== expectedPlatforms.join(",")) {
    failures.push(
      `create-scratchwork-server: packed templates [${packedPlatforms.join(", ")}] != expected [${expectedPlatforms.join(", ")}]`,
    );
  }
  for (const platform of packedPlatforms) {
    const label = `create-scratchwork-server (${platform})`;
    const targetName = `scaffold-${platform}`;
    const target = join(consumer, targetName);
    const scaffoldRun = Bun.spawnSync(
      ["node", join(createPackage, "dist", "index.js"), targetName, "--platform", platform],
      { cwd: consumer, stdout: "pipe", stderr: "pipe" },
    );
    if (!scaffoldRun.success) {
      failures.push(`${label}: scaffold under node failed:\n${scaffoldRun.stderr.toString().slice(0, 2000)}`);
      continue;
    }
    for (const required of ["package.json", "tsconfig.json", "README.md", ".gitignore"]) {
      if (!existsSync(join(target, required))) failures.push(`${label}: scaffold is missing ${required}`);
    }
    const scaffolded = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    for (const [dep, range] of Object.entries((scaffolded.dependencies ?? {}) as Record<string, string>)) {
      if (dep.startsWith("@scratchwork/") && range !== rootVersion) {
        failures.push(`${label}: scaffold pins ${dep}@${range}, expected the lockstep ${rootVersion}`);
      }
    }
    // The scaffolded template pins typescript ^6 (baseUrl etc.), so run the
    // consumer-resolved typescript rather than whatever `bunx tsc` picks up.
    const scaffoldTsc = Bun.spawnSync(
      ["node", join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      { cwd: target, stdout: "pipe", stderr: "pipe" },
    );
    if (!scaffoldTsc.success) {
      failures.push(`${label}: scaffolded project typecheck failed:\n${scaffoldTsc.stdout.toString().slice(0, 2000)}`);
    }
  }
  rmSync(consumer, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check-npm-pack: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}
console.log(
  `check-npm-pack: ${packages.length} tarballs verified (shape, manifest, Node/Bun import smoke, NodeNext consumer typecheck, ` +
    `scaffolded ${Object.keys(TEMPLATE_SOURCES).length} create-scratchwork-server templates)`,
);
