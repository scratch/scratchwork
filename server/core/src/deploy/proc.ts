/*
 * Process spawning for the deploy scripts. Uses node:child_process (not
 * Bun.spawn) so published deploy tooling runs under plain Node as well as Bun.
 */
import { spawn } from "node:child_process";

/** Options for one spawned command. */
export interface RunOptions {
  readonly allowFailure?: boolean;
  readonly capture?: boolean;
  readonly cwd?: string;
}

/** Exit status and captured output of one spawned command. */
export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Creates a command runner that uses one captured deploy environment. */
export function createRunner(commandEnv: Record<string, string>) {
  return {
    run: (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
      run(command, args, commandEnv, options),
  };
}

/** Spawns one command and optionally captures output or tolerates failure. */
function run(
  command: string,
  args: ReadonlyArray<string>,
  commandEnv: Record<string, string>,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: commandEnv,
      stdio: [
        "inherit",
        options.capture ? "pipe" : "inherit",
        options.capture || options.allowFailure ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0 && !options.allowFailure) {
        if (stderr) process.stderr.write(stderr);
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`));
        return;
      }
      resolve({ ok: exitCode === 0, stdout, stderr });
    });
  });
}
