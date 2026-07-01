export interface RunOptions {
  readonly allowFailure?: boolean;
  readonly capture?: boolean;
  readonly cwd?: string;
}

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
async function run(
  command: string,
  args: ReadonlyArray<string>,
  commandEnv: Record<string, string>,
  options: RunOptions,
): Promise<RunResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: commandEnv,
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture || options.allowFailure ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout),
    read(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
  }
  return { ok: exitCode === 0, stdout, stderr };
}

/** Reads a spawned process stream into a string. */
async function read(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (stream == null) return "";
  return new Response(stream).text();
}
