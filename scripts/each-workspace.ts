#!/usr/bin/env bun
/*
 * Runs one script (typecheck | test | ci) in every workspace. The list is
 * derived from the root package.json workspaces globs, so a new workspace
 * joins the gate automatically — and a workspace missing the script fails the
 * whole run instead of being silently skipped.
 *
 * Workspaces run concurrently (bounded by CPU count); each one's output is
 * buffered and printed as a single block when it finishes, so logs never
 * interleave. Every workspace runs even if another fails, and all failures
 * are reported at the end.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, runPooled } from "./pool";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = process.argv[2];
const runnable = ["typecheck", "test", "ci"];
if (!script || !runnable.includes(script)) {
  console.error(`usage: bun scripts/each-workspace.ts <${runnable.join(" | ")}>`);
  process.exit(1);
}

// Both the renderer and cli builds write shared/src/site/default-renderer.generated.js
// and renderer/dist (cli/build.js calls the renderer's buildDist), so they must
// never run concurrently. Each listed workspace starts only after its blockers finish.
// e2e bundles the CLI (which embeds renderer artifacts), so it starts after cli.
const runAfter: Record<string, string[]> = { cli: ["renderer"], e2e: ["cli"] };

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
for (const [dir, blockers] of Object.entries(runAfter)) {
  const unknown = blockers.filter((b) => !dirs.includes(b));
  if (dirs.includes(dir) && unknown.length > 0) {
    console.error(`runAfter[${dir}] names non-workspace dirs: ${unknown.join(", ")}`);
    process.exit(1);
  }
}

const pool = createPool();

// `finished` is fully populated with deferred promises before any workspace
// starts, so a runAfter blocker resolves correctly no matter where it appears
// in the workspaces list. (runAfter must stay acyclic — a cycle would wait
// forever.)
const finished = new Map<string, Promise<boolean>>();
const resolvers = new Map<string, (ok: boolean) => void>();
for (const dir of dirs) {
  finished.set(dir, new Promise<boolean>((resolve) => resolvers.set(dir, resolve)));
}

async function run(dir: string): Promise<boolean> {
  // Await blockers before runPooled takes a slot, so waiting cannot deadlock
  // the pool (see createPool).
  await Promise.all((runAfter[dir] ?? []).map((blocker) => finished.get(blocker)));
  return runPooled(pool, ["bun", "run", script], {
    cwd: join(root, dir),
    title: `${dir}: bun run ${script}`,
  });
}

for (const dir of dirs) run(dir).then((ok) => resolvers.get(dir)!(ok));
const results = await Promise.all(dirs.map((dir) => finished.get(dir)!));
const failed = dirs.filter((_, i) => !results[i]);
if (failed.length > 0) {
  console.error(`\n${script} failed in: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\n${script} passed in all ${dirs.length} workspaces: ${dirs.join(", ")}`);
