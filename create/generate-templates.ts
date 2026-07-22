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
 *   - the access policy fails closed: whatever allowedUsers value the deploy
 *     source carries (including none) becomes allowedUsers: "@example.com",
 *     riding the same placeholder edit as the domains — a scaffolded server
 *     never starts out world-signupable by accident;
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

/** The fail-closed access-policy placeholder every template ships with. */
export const TEMPLATE_ALLOWED_USERS = '@example.com';

const ALLOWED_USERS_LINE = `allowedUsers: "${TEMPLATE_ALLOWED_USERS}", // emails and @domains (comma-separated), or "public"`;

/** Replaces the sndbx.sh-specific values in deploy sources with placeholders. */
function substitutePlaceholders(text: string): string {
  return text.replaceAll("sndbx.sh", "example.com").replaceAll("sndbx-sh", "example-com");
}

/**
 * Forces the scaffolded access policy to the fail-closed placeholder: an
 * existing allowedUsers value (e.g. "public" in deploy/cloudflare-vanilla) is
 * replaced, and a server-settings object without one (the aws and local
 * sources) gets it inserted after its `auth:` line. Files that do not define
 * server settings pass through unchanged.
 */
function substituteAccessPolicy(text: string): string {
  if (/allowedUsers:/.test(text)) {
    return text.replace(/allowedUsers:\s*"[^"]*",?[^\n]*/g, ALLOWED_USERS_LINE);
  }
  return text.replace(
    /^([ \t]*)auth: "[^"]+",?[^\n]*\n/m,
    (line, indent: string) => line + `${indent}${ALLOWED_USERS_LINE}\n`,
  );
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
        const transformed = name.endsWith(".ts")
          ? substituteAccessPolicy(substitutePlaceholders(text))
          : substitutePlaceholders(text);
        writeFileSync(join(out, outName), transformed);
      }
    }

    // The fail-closed access-policy placeholder must land exactly once, and
    // nothing else may set allowedUsers — fail the build if the deploy
    // sources change shape in a way the transform no longer covers.
    const codeTexts = readdirSync(out)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(out, name), "utf8"));
    const placeholderCount = codeTexts.reduce(
      (count, text) => count + (text.match(new RegExp(`allowedUsers: "${TEMPLATE_ALLOWED_USERS}"`, "g"))?.length ?? 0),
      0,
    );
    const totalCount = codeTexts.reduce((count, text) => count + (text.match(/allowedUsers:/g)?.length ?? 0), 0);
    if (placeholderCount !== 1 || totalCount !== 1) {
      throw new Error(
        `generate-templates: ${platform} template must set allowedUsers to "${TEMPLATE_ALLOWED_USERS}" exactly once ` +
          `(found ${placeholderCount} placeholder / ${totalCount} total) — the deploy source's shape no longer matches the transform`,
      );
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
