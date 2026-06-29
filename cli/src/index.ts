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
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import pkg from "../package.json";
import { runExample } from "./commands/example";
import { runLogin } from "./commands/login";
import { DEFAULT_PORT, runDev } from "./commands/dev";
import { runPublish } from "./commands/publish";
import { runTemplate } from "./commands/template";
import { CliError } from "./errors";

const pathArg = (name = "path", fallback = ".") =>
  Args.text({ name }).pipe(Args.withDefault(fallback));

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

const templateCommand = Command.make(
  "template",
  {
    file: pathArg("file", "index.html"),
  },
  runTemplate,
).pipe(Command.withDescription("Write the default Markdown HTML template"));

const publishCommand = Command.make(
  "publish",
  {
    path: pathArg("path"),
    server: Options.text("server").pipe(
      Options.withDefault(""),
      Options.withDescription("Scratchwork server URL"),
    ),
    slug: Options.text("slug").pipe(
      Options.withDefault(""),
      Options.withDescription("Existing slug to republish"),
    ),
    token: Options.text("token").pipe(
      Options.withDefault(""),
      Options.withDescription("Publish token for an existing slug"),
    ),
  },
  runPublish,
).pipe(Command.withDescription("Publish a static site to a Scratchwork server"));

const loginCommand = Command.make(
  "login",
  {
    server: Options.text("server").pipe(
      Options.withDefault(""),
      Options.withDescription("Scratchwork server URL"),
    ),
  },
  runLogin,
).pipe(Command.withDescription("Authenticate with a Scratchwork server"));

const versionCommand = Command.make("version", {}, () =>
  Console.log(pkg.version),
).pipe(Command.withDescription("Print the version"));

const scratchworkCommand = Command.make("scratchwork").pipe(
  Command.withDescription("CLI for Scratchwork projects"),
  Command.withSubcommands([
    devCommand,
    exampleCommand,
    loginCommand,
    publishCommand,
    templateCommand,
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
      error instanceof CliError
        ? (error.message ? Console.error(error.message) : Effect.void).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                process.exitCode = error.code;
              }),
            ),
          )
        : Effect.fail(error),
    ),
    Effect.provide(MainLayer),
    BunRuntime.runMain,
  );
}

runScratchworkCli();
