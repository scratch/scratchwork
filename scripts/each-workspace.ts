#!/usr/bin/env bun
/*
 * Runs one script (typecheck | test | ci) in every workspace, in the order the
 * root package.json lists them. The list is derived from the workspaces globs,
 * so a new workspace joins the gate automatically — and a workspace missing
 * the script fails the whole run instead of being silently skipped.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = process.argv[2];
const runnable = ["typecheck", "test", "ci"];
if (!script || !runnable.includes(script)) {
  console.error(`usage: bun scripts/each-workspace.ts <${runnable.join(" | ")}>`);
  process.exit(1);
}

/** Expands the root workspaces globs (literal dirs and trailing "/*") into workspace dirs. */
function workspaceDirs(): string[] {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs: string[] = [];
  for (const pattern of rootPackage.workspaces as string[]) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) {
          dirs.push(join(parent, entry.name));
        }
      }
    } else {
      dirs.push(pattern);
    }
  }
  return dirs;
}

const dirs = workspaceDirs();
const missing = dirs.filter((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  return typeof pkg.scripts?.[script] !== "string";
});
if (missing.length > 0) {
  console.error(`every workspace must define a "${script}" script; missing in: ${missing.join(", ")}`);
  process.exit(1);
}

for (const dir of dirs) {
  console.log(`\n=== ${dir}: bun run ${script} ===`);
  const proc = Bun.spawnSync(["bun", "run", script], {
    cwd: join(root, dir),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!proc.success) {
    console.error(`\n${dir}: bun run ${script} failed`);
    process.exit(1);
  }
}
console.log(`\n${script} passed in all ${dirs.length} workspaces: ${dirs.join(", ")}`);
