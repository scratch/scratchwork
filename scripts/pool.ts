/*
 * Shared bounded-concurrency runner for the repo's process pools
 * (scripts/each-workspace.ts, cli/test/run.ts): run commands concurrently up
 * to a slot count, buffer each one's output, and print it as a single block
 * when it finishes, so logs never interleave.
 */
import { availableParallelism } from "node:os";

export interface Pool {
  acquire: () => Promise<void>;
  release: () => void;
}

// A tiny semaphore. Callers that need ordering between commands must await
// their blockers BEFORE acquire() (as runPooled does nothing until it holds a
// slot, waiting on a blocker never holds one) — so ordering cannot deadlock
// the pool.
export function createPool(size: number = availableParallelism()): Pool {
  let slots = Math.max(1, size);
  const waiters: Array<() => void> = [];
  return {
    acquire: () =>
      slots > 0 ? (slots--, Promise.resolve()) : new Promise<void>((resolve) => waiters.push(resolve)),
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else slots++;
    },
  };
}

/**
 * Runs `cmd` under a pool slot with stdout/stderr buffered, then prints one
 * `=== title verdict (Ns) ===` block followed by the output. Returns whether
 * the command exited 0.
 */
export async function runPooled(
  pool: Pool,
  cmd: string[],
  { cwd, env, title }: { cwd: string; env?: Record<string, string | undefined>; title: string },
): Promise<boolean> {
  await pool.acquire();
  try {
    const started = Date.now();
    const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n=== ${title} ${code === 0 ? "ok" : "FAILED"} (${seconds}s) ===`);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    return code === 0;
  } finally {
    pool.release();
  }
}
