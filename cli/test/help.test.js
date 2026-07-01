import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(TEST_DIR, "..");
const SCRATCHWORK = join(CLI_DIR, "src", "index.ts");

const COMMANDS = [
  "clone",
  "delete",
  "dev",
  "example",
  "info",
  "login",
  "me",
  "projects",
  "publish",
  "stream",
  "template",
  "unpublish",
  "version",
];

async function runCli(args) {
  const proc = Bun.spawn(["bun", SCRATCHWORK, ...args], {
    env: { ...process.env, SCRATCHWORK_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("CLI help", () => {
  test("prints useful top-level help", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scratchwork <command> [options]");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("scratchwork help publish");
    expect(result.stdout).not.toContain("A user-defined piece of text");
    expect(result.stdout).not.toContain("\u001b[");
  });

  test("prints useful help for every subcommand", async () => {
    for (const command of COMMANDS) {
      const result = await runCli([command, "--help"]);

      expect(result.code, command).toBe(0);
      expect(result.stderr, command).toBe("");
      expect(result.stdout, command).toContain(`scratchwork ${command}`);
      expect(result.stdout, command).toContain("Usage:");
      expect(result.stdout, command).toContain("Examples:");
      expect(result.stdout, command).not.toContain("A user-defined piece of text");
      expect(result.stdout, command).not.toContain("\u001b[");
    }
  });

  test("supports help before or after the subcommand name", async () => {
    const before = await runCli(["help", "publish"]);
    const after = await runCli(["publish", "help"]);

    expect(before.code).toBe(0);
    expect(after.code).toBe(0);
    expect(before.stdout).toBe(after.stdout);
    expect(before.stdout).toContain("scratchwork publish [path] --server <url>");
    expect(before.stdout).toContain("--visibility <scope>");
  });

  test("keeps no-command behavior but prints the new root help", async () => {
    const result = await runCli([]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("scratchwork <command> [options]");
    expect(result.stdout).not.toContain("A user-defined piece of text");
  });
});
