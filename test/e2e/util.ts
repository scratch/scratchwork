import path from "path";
import { spawnSync } from "child_process";
import { getRepoRoot } from "../../src/util";

// Re-export shared test utility
export { mkTempDir } from "../test-util";

/**
 * Helper: sleep for the specified milliseconds.
 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper that executes the CLI synchronously and throws if it exits with a
 * non–zero status code.
 */
export function runCliSync(args: string[], cwd: string) {
  const repoRoot = getRepoRoot();
  const indexPath = path.resolve(repoRoot, "src", "index.ts");

  const result = spawnSync("bun", [indexPath, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`scratch CLI ${args.join(" ")} exited with code ${result.status}`);
  }
}