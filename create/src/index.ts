#!/usr/bin/env node
/*
 * create-scratchwork-server — the bin behind `npm create scratchwork-server`.
 * Scaffolds a standalone self-hosted Scratchwork server project from a
 * platform template (cloudflare | aws | local):
 *
 *   npm create scratchwork-server my-server -- --platform cloudflare
 *   bun create scratchwork-server my-server --platform cloudflare
 *
 * Non-interactive by design (agents are a primary audience): with a directory
 * and --platform it never prompts; without --platform it prompts only on a
 * TTY and errors otherwise. Runs under plain Node — node: builtins only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { listPlatforms, scaffold } from "./scaffold.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(packageRoot, "templates");
const ownVersion = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;

const DEFAULT_DIR = "scratchwork-server";

function usage(platforms: readonly string[]): string {
  return [
    "Usage: npm create scratchwork-server [directory] -- --platform <platform>",
    "",
    `  directory              target directory (default: ${DEFAULT_DIR})`,
    `  --platform, -p         one of: ${platforms.join(", ")}`,
    "  --help, -h             show this help",
    "  --version, -v          print the version",
    "",
    "Example:",
    "  npm create scratchwork-server my-server -- --platform cloudflare",
  ].join("\n");
}

interface ParsedArgs {
  readonly directory: string | undefined;
  readonly platform: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let directory: string | undefined;
  let platform: string | undefined;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg === "--platform" || arg === "-p") platform = argv[++i];
    else if (arg.startsWith("--platform=")) platform = arg.slice("--platform=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
    else if (directory === undefined) directory = arg;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  return { directory, platform, help, version };
}

async function promptPlatform(platforms: readonly string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Platform (${platforms.join(", ")}): `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const platforms = listPlatforms(templatesDir);
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`create-scratchwork-server: ${(error as Error).message}\n`);
    console.error(usage(platforms));
    return 1;
  }
  if (args.help) {
    console.log(usage(platforms));
    return 0;
  }
  if (args.version) {
    console.log(ownVersion);
    return 0;
  }
  let platform = args.platform;
  if (platform === undefined || platform === "") {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      platform = await promptPlatform(platforms);
    } else {
      console.error("create-scratchwork-server: --platform is required when not running interactively\n");
      console.error(usage(platforms));
      return 1;
    }
  }

  const directory = args.directory ?? DEFAULT_DIR;
  let result;
  try {
    result = scaffold(templatesDir, platform, directory);
  } catch (error) {
    console.error(`create-scratchwork-server: ${(error as Error).message}`);
    return 1;
  }

  const steps = [
    `cd ${directory}`,
    "bun install",
    ...(result.hasEnvExample ? ["cp .env.example .env   # then fill in the secrets"] : []),
    ...(result.scripts.includes("local") ? ["bun run local          # run the server locally"] : []),
    ...(result.scripts.includes("deploy") ? ["bun run deploy         # deploy it"] : []),
  ];
  console.log(`Scaffolded a Scratchwork ${platform} server project in ${directory}/`);
  console.log("\nNext steps:\n");
  for (const step of steps) console.log(`  ${step}`);
  console.log("\nSee the project's README.md for configuration details.");
  return 0;
}

process.exit(await main());
