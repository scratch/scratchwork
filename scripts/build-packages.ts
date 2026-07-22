#!/usr/bin/env bun
/*
 * Builds the six publishable npm packages (notes/distribution-plan.md
 * Phase 4) and stages publishable directories under release/packages/:
 *
 *   1. tsc emit (ESM JS + .d.ts) into each package's dist/, in dependency
 *      order (shared → server-core → deploy adapters) so each build resolves
 *      its workspace deps against their already-built dist via tsconfig paths.
 *   2. Post-process emitted .d.ts: tsc's rewriteRelativeImportExtensions
 *      rewrites `.ts` specifiers to `.js` in JS output but NOT in declaration
 *      output, so the same rewrite is applied here — a shipped d.ts referencing
 *      "./x.ts" would fail consumers' typechecking.
 *   3. Stage release/packages/<dir>/ with dist/, README.md, the root LICENSE,
 *      and a publish-shaped package.json: exports/bin/files pointed at dist/,
 *      workspace:* pinned to the lockstep version, dev-only fields dropped.
 *      (Neither bun nor npm applies publishConfig.exports, and `bun publish`
 *      only rewrites workspace:* when run from the workspace itself, so the
 *      staging transform owns both.)
 *   4. For create-scratchwork-server, generate the platform templates from
 *      the deploy/* projects into the staged templates/ dir
 *      (create/generate-templates.ts), pinning @scratchwork deps to the
 *      lockstep version — templates are never committed, so they cannot
 *      drift from the deploy sources.
 *
 * scripts/check-npm-pack.ts packs and verifies the staged output in ci;
 * scripts/publish-packages.ts publishes it.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTemplates } from "../create/generate-templates";
import { repoRoot } from "./workspaces";

/** Publishable packages in dependency order (dir is repo-relative). */
export const PUBLISHABLE = [
  "shared",
  "server/core",
  "server/deploy-local",
  "server/deploy-aws",
  "server/deploy-cloudflare",
  "create",
] as const;

const rootVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;

/** Maps an in-repo exports target (./src/X.ts, ./src/*.js) to its published shape. */
function publishedExportTarget(target: string): { types: string; default: string } {
  if (!target.startsWith("./src/")) {
    throw new Error(`exports target ${target} does not point into src/ — extend the staging transform`);
  }
  const inDist = "./dist/" + target.slice("./src/".length);
  if (inDist.endsWith(".ts")) {
    const base = inDist.slice(0, -3);
    return { types: `${base}.d.ts`, default: `${base}.js` };
  }
  if (inDist.endsWith(".js")) {
    const base = inDist.slice(0, -3);
    return { types: `${base}.d.ts`, default: `${base}.js` };
  }
  throw new Error(`exports target ${target} has an unexpected extension — extend the staging transform`);
}

/** The publish-shaped package.json: dist exports/bin, pinned deps, dev fields dropped. */
function publishManifest(pkg: Record<string, unknown>): Record<string, unknown> {
  const exports = pkg.exports
    ? Object.fromEntries(
        Object.entries(pkg.exports as Record<string, string>).map(([key, target]) => [
          key,
          publishedExportTarget(target),
        ]),
      )
    : undefined;
  const bin = pkg.bin
    ? Object.fromEntries(
        Object.entries(pkg.bin as Record<string, string>).map(([name, target]) => [
          name,
          publishedExportTarget(target).default,
        ]),
      )
    : undefined;
  const dependencies = Object.fromEntries(
    Object.entries((pkg.dependencies as Record<string, string>) ?? {}).map(([name, range]) => [
      name,
      range === "workspace:*" ? rootVersion : range,
    ]),
  );
  const { name, version, type, description, license, repository, engines, keywords } = pkg as Record<string, unknown>;
  return {
    name,
    version,
    type,
    description,
    license,
    repository,
    engines,
    ...(keywords ? { keywords } : {}),
    ...(exports ? { exports } : {}),
    ...(bin ? { bin } : {}),
    files: (pkg.files as string[] | undefined) ?? ["dist"],
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };
}

/** Rewrites relative `.ts` import specifiers to `.js` in an emitted .d.ts. */
function rewriteDeclarationSpecifiers(text: string): string {
  return text.replace(/((?:from\s*|import\s*\()\s*["'])(\.{1,2}\/[^"']*)\.ts(["'])/g, "$1$2.js$3");
}

export function buildAndStage(): string[] {
  const staged: string[] = [];
  for (const dir of PUBLISHABLE) {
    const packageDir = join(repoRoot, dir);
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });
    const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], {
      cwd: packageDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!tsc.success) {
      console.error(`build-packages: tsc failed for ${dir}`);
      process.exit(1);
    }
    for (const file of new Bun.Glob("**/*.d.ts").scanSync({ cwd: join(packageDir, "dist") })) {
      const path = join(packageDir, "dist", file);
      const text = readFileSync(path, "utf8");
      const rewritten = rewriteDeclarationSpecifiers(text);
      if (rewritten !== text) writeFileSync(path, rewritten);
    }

    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const staging = join(repoRoot, "release", "packages", dir.replaceAll("/", "-"));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(join(packageDir, "dist"), join(staging, "dist"), { recursive: true });
    writeFileSync(join(staging, "package.json"), JSON.stringify(publishManifest(pkg), null, 2) + "\n");
    cpSync(join(repoRoot, "LICENSE"), join(staging, "LICENSE"));
    const readme = join(packageDir, "README.md");
    if (!existsSync(readme)) {
      console.error(`build-packages: ${dir} has no README.md — every published package ships one`);
      process.exit(1);
    }
    cpSync(readme, join(staging, "README.md"));
    // The scaffolder's templates are generated from the deploy/* sources at
    // staging time (never committed), so template content cannot drift.
    if (dir === "create") generateTemplates(join(staging, "templates"), rootVersion);
    staged.push(staging);
    console.log(`staged ${staging.slice(repoRoot.length + 1)} (${pkg.name}@${rootVersion})`);
  }
  return staged;
}

if (import.meta.main) {
  buildAndStage();
}
