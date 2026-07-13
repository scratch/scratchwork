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
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const runAfter: Record<string, string[]> = { cli: ["renderer"] };

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

// A tiny semaphore; waiting on a blocker never holds a slot, so runAfter
// ordering cannot deadlock the pool.
let slots = Math.max(1, availableParallelism());
const waiters: Array<() => void> = [];
const acquire = () =>
  slots > 0 ? (slots--, Promise.resolve()) : new Promise<void>((resolve) => waiters.push(resolve));
const release = () => {
  const next = waiters.shift();
  if (next) next();
  else slots++;
};

const finished = new Map<string, Promise<boolean>>();

async function run(dir: string): Promise<boolean> {
  await Promise.all((runAfter[dir] ?? []).map((blocker) => finished.get(blocker)));
  await acquire();
  try {
    const started = Date.now();
    const proc = Bun.spawn(["bun", "run", script], {
      cwd: join(root, dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const verdict = code === 0 ? "ok" : "FAILED";
    console.log(`\n=== ${dir}: bun run ${script} ${verdict} (${seconds}s) ===`);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    return code === 0;
  } finally {
    release();
  }
}

for (const dir of dirs) finished.set(dir, run(dir));
const results = await Promise.all(dirs.map((dir) => finished.get(dir)!));
const failed = dirs.filter((_, i) => !results[i]);
if (failed.length > 0) {
  console.error(`\n${script} failed in: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\n${script} passed in all ${dirs.length} workspaces: ${dirs.join(", ")}`);
