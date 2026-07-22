/*
 * Generates the create-scratchwork-server platform templates from the real
 * deploy/* projects. Templates are never committed or hand-maintained: they
 * are regenerated from the deploy sources on every build/pack
 * (scripts/build-packages.ts) and in this workspace's tests, so template
 * content structurally cannot drift from the deploy projects (AGENTS.md
 * invariant 2's spirit).
 *
 * Per platform, the transform is mechanical:
 *   - every committed file of the deploy project is copied with the
 *     sndbx.sh-specific values replaced by example.com placeholders;
 *   - package.json becomes a standalone project manifest: workspace:* deps
 *     pinned to the exact lockstep version passed in, repo-only scripts
 *     (ci/test) dropped, name set to a placeholder the scaffolder overwrites;
 *   - tsconfig.json drops the ../../shared includes that only make sense
 *     inside this repository;
 *   - README.md is replaced (the deploy READMEs describe this repo's own
 *     deployments) and a gitignore is added, both from templates-src/;
 *   - dotfiles are stored with a leading underscore (npm strips or repurposes
 *     some dotfiles in packed packages); scaffold() renames them back.
 *
 * Dev/build tooling only — this file is not shipped in the npm package.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const templatesSrc = join(repoRoot, "create", "templates-src");

/** Template platform → the deploy project it is generated from (repo-relative). */
export const TEMPLATE_SOURCES = {
  cloudflare: "deploy/cloudflare-vanilla",
  aws: "deploy/generic-aws",
  local: "deploy/local-dev",
} as const;

export type TemplatePlatform = keyof typeof TEMPLATE_SOURCES;

/** Placeholder name in template package.json; scaffold() overwrites it. */
export const TEMPLATE_PROJECT_NAME = "scratchwork-server";

/** Replaces the sndbx.sh-specific values in deploy sources with placeholders. */
function substitutePlaceholders(text: string): string {
  return text.replaceAll("sndbx.sh", "example.com").replaceAll("sndbx-sh", "example-com");
}

/** The standalone-project package.json derived from a deploy project's. */
function templateManifest(source: Record<string, unknown>, version: string): Record<string, unknown> {
  const scripts = Object.fromEntries(
    Object.entries((source.scripts as Record<string, string>) ?? {}).filter(([name]) => name !== "ci" && name !== "test"),
  );
  const dependencies = Object.fromEntries(
    Object.entries((source.dependencies as Record<string, string>) ?? {}).map(([name, range]) => [
      name,
      range === "workspace:*" ? version : range,
    ]),
  );
  return {
    name: TEMPLATE_PROJECT_NAME,
    version: "0.0.0",
    private: true,
    type: source.type,
    scripts,
    dependencies,
    devDependencies: source.devDependencies,
  };
}

/** The standalone tsconfig: same options, minus includes reaching into this repo. */
function templateTsconfig(source: { compilerOptions: unknown; include: string[] }): Record<string, unknown> {
  return {
    compilerOptions: source.compilerOptions,
    include: source.include.filter((pattern) => !pattern.startsWith("..")),
  };
}

/**
 * Writes the templates for every platform under outDir, pinning @scratchwork
 * dependencies to `version` (the repo's lockstep version at build/pack time).
 */
export function generateTemplates(outDir: string, version: string): void {
  for (const [platform, sourceDir] of Object.entries(TEMPLATE_SOURCES)) {
    const source = join(repoRoot, sourceDir);
    const out = join(outDir, platform);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });

    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile()) continue; // deploy projects are flat; local state dirs are skipped
      const name = entry.name;
      if (name === "README.md") continue; // replaced by templates-src (repo-specific prose)
      if (name.startsWith(".") && name !== ".env.example") continue; // .env, editor droppings
      const text = readFileSync(join(source, name), "utf8");
      if (name === "package.json") {
        writeFileSync(join(out, name), JSON.stringify(templateManifest(JSON.parse(text), version), null, 2) + "\n");
      } else if (name === "tsconfig.json") {
        writeFileSync(join(out, name), JSON.stringify(templateTsconfig(JSON.parse(text)), null, 2) + "\n");
      } else {
        const outName = name.startsWith(".") ? "_" + name.slice(1) : name;
        writeFileSync(join(out, outName), substitutePlaceholders(text));
      }
    }

    // Hand-written standalone extras: README.md and _gitignore per platform.
    const extras = join(templatesSrc, platform);
    for (const name of readdirSync(extras)) {
      writeFileSync(join(out, name), readFileSync(join(extras, name), "utf8"));
    }
    for (const required of ["README.md", "_gitignore", "package.json", "tsconfig.json"]) {
      if (!existsSync(join(out, required))) {
        throw new Error(`generate-templates: ${platform} template is missing ${required}`);
      }
    }
  }
}
