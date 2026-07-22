/*
 * Core scaffolding logic for create-scratchwork-server: copies one platform
 * template into a target directory and personalizes it. Kept separate from
 * the bin entrypoint so tests can drive it directly against generated
 * templates. Must run under plain Node — node: builtins only, no Bun APIs.
 *
 * Template convention: files that must be dotfiles in the scaffolded project
 * are stored with a leading underscore (`_env.example`, `_gitignore`) because
 * npm strips or repurposes some dotfiles when packing/installing a package.
 * scaffold() renames a leading `_` back to `.`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** What was scaffolded, for the bin's next-steps output. */
export interface ScaffoldResult {
  /** Absolute path of the scaffolded project. */
  readonly dir: string;
  /** The npm package name written into the project's package.json. */
  readonly projectName: string;
  /** Script names available in the scaffolded package.json (e.g. local, deploy). */
  readonly scripts: readonly string[];
  /** Whether the template ships a .env.example to copy to .env. */
  readonly hasEnvExample: boolean;
}

/** The platforms available in a templates directory (one subdirectory each). */
export function listPlatforms(templatesDir: string): string[] {
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A valid npm package name derived from the target directory's basename. */
export function projectNameFor(targetDir: string): string {
  const name = basename(resolve(targetDir))
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
    .replace(/^[-._]+/, "");
  return name === "" ? "scratchwork-server" : name;
}

/** Copies the platform template into targetDir and personalizes package.json. */
export function scaffold(templatesDir: string, platform: string, targetDir: string): ScaffoldResult {
  const platforms = listPlatforms(templatesDir);
  if (!platforms.includes(platform)) {
    throw new Error(`unknown platform "${platform}" — expected one of: ${platforms.join(", ")}`);
  }
  const target = resolve(targetDir);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error(`${target} exists and is not a directory`);
    if (readdirSync(target).length > 0) throw new Error(`${target} already exists and is not empty`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(join(templatesDir, platform), target, { recursive: true });

  // Restore dotfiles stored under the leading-underscore convention.
  for (const entry of readdirSync(target)) {
    if (entry.startsWith("_")) renameSync(join(target, entry), join(target, "." + entry.slice(1)));
  }

  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const projectName = projectNameFor(target);
  manifest.name = projectName;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    dir: target,
    projectName,
    scripts: Object.keys((manifest.scripts as Record<string, string>) ?? {}),
    hasEnvExample: existsSync(join(target, ".env.example")),
  };
}
