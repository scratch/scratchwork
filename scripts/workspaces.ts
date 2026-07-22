/*
 * Workspace discovery shared by the root scripts: expands the root
 * package.json workspaces globs (literal dirs and trailing "/*") into the
 * list of workspace directories, so every script derives the same list and a
 * new workspace joins them all automatically.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Expands the root workspaces globs into workspace dirs (repo-relative). */
export function workspaceDirs(): string[] {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const dirs: string[] = [];
  for (const pattern of rootPackage.workspaces as string[]) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(repoRoot, parent, entry.name, "package.json"))) {
          dirs.push(join(parent, entry.name));
        }
      }
    } else {
      dirs.push(pattern);
    }
  }
  return dirs;
}
