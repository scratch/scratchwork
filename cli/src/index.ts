#!/usr/bin/env bun
/*
 * Entrypoint and Effect CLI command graph for the scratchwork binary.
 * Command modules own behavior; this file declares the public CLI surface,
 * wires command handlers to Effect, and adapts Effect exits to process exits.
 */
import * as Args from "@effect/cli/Args";
import * as CliConfig from "@effect/cli/CliConfig";
import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import pkg from "../package.json";
import { runLogin, runLogout, runWhoami } from "./commands/auth";
import { runExample } from "./commands/example";
import { DEFAULT_PORT, runDev } from "./commands/dev";
import { CliError, ExitError } from "./errors";
import * as cfg from "./lib/config.js";

function commandTask(
  thunk: () => void | Promise<void>,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await thunk();
    },
    catch: (error) => error,
  });
}

const handler =
  <A>(fn: (config: A) => void | Promise<void>) =>
  (config: A) =>
    commandTask(() => fn(config));

const pathArg = (name = "path", fallback = ".") =>
  Args.text({ name }).pipe(Args.withDefault(fallback));

const optionalText = (name: string) =>
  Options.text(name).pipe(Options.withDefault(null));

const serverOption = () =>
  optionalText("server").pipe(
    Options.withDescription(
      `Server URL (default: global config, then ${cfg.DEFAULT_SERVER})`,
    ),
  );

// ---------------------------------------------------------------------------
// Top-level project commands
// ---------------------------------------------------------------------------
const devCommand = Command.make(
  "dev",
  {
    path: pathArg("path"),
    port: Options.integer("port").pipe(
      Options.withAlias("p"),
      Options.withDefault(DEFAULT_PORT),
      Options.withDescription("Starting port to probe upward from"),
    ),
    verbose: Options.boolean("verbose").pipe(
      Options.withDescription("Show Effect debug logs for the dev server"),
    ),
  },
  runDev,
).pipe(Command.withDescription("Serve a project with hot reload"));

const exampleCommand = Command.make(
  "example",
  {
    path: pathArg("path"),
  },
  runExample,
).pipe(Command.withDescription("Write example Markdown and React files"));

// ---------------------------------------------------------------------------
// Account commands
// ---------------------------------------------------------------------------
const loginCommand = Command.make(
  "login",
  {
    server: serverOption(),
    token: optionalText("token").pipe(
      Options.withDescription("Token to store instead of using browser login"),
    ),
  },
  handler(runLogin),
).pipe(Command.withDescription("Log in to a Scratchwork server"));

const logoutCommand = Command.make(
  "logout",
  {
    server: serverOption(),
  },
  handler(runLogout),
).pipe(Command.withDescription("Forget a server's credentials"));

const whoamiCommand = Command.make(
  "whoami",
  {
    server: serverOption(),
  },
  handler(runWhoami),
).pipe(Command.withDescription("Show who you are logged in as"));

const versionCommand = Command.make("version", {}, () =>
  Effect.sync(() => console.log(pkg.version)),
).pipe(Command.withDescription("Print the version"));

const scratchworkCommand = Command.make("scratchwork").pipe(
  Command.withDescription("CLI for Scratchwork projects"),
  Command.withSubcommands([
    devCommand,
    exampleCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    versionCommand,
  ]),
);

function normalizeArgv(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  if (argv.length < 3) return argv;
  const normalized = [...argv];
  if (normalized[2] === "help") normalized[2] = "--help";
  if (normalized[2] === "-v") normalized[2] = "--version";
  return normalized;
}

const cli = Command.run(scratchworkCommand, {
  name: "scratchwork",
  version: pkg.version,
});

const MainLayer = Layer.mergeAll(
  CliConfig.layer({ showBuiltIns: false }),
  BunHttpServer.layerContext,
);

function runScratchworkCli(argv: ReadonlyArray<string> = process.argv): void {
  const normalizedArgv = normalizeArgv(argv);
  const noCommand = normalizedArgv.length < 3;

  Effect.suspend(() => cli(normalizedArgv)).pipe(
    Effect.tap(() =>
      noCommand
        ? Effect.sync(() => {
            process.exitCode = 1;
          })
        : Effect.void,
    ),
    Effect.catchAll((error) =>
      error instanceof ExitError || error instanceof CliError
        ? Effect.sync(() => {
            if (error instanceof CliError && error.message) {
              console.error(error.message);
            }
            process.exitCode = error.code;
          })
        : Effect.fail(error),
    ),
    Effect.provide(MainLayer),
    BunRuntime.runMain,
  );
}

runScratchworkCli();
