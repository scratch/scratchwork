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
import { runClone, runDelete, runInfo, runMe, runProjects, runStream, runUnpublish } from "./commands/projects";
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
    workspace: Options.text("workspace").pipe(
      Options.withDefault(""),
      Options.withDescription("Workspace name"),
    ),
    project: Options.text("project").pipe(
      Options.withDefault(""),
      Options.withDescription("Project name"),
    ),
    visibility: Options.text("visibility").pipe(
      Options.withDefault(""),
      Options.withDescription("Project visibility group"),
    ),
  },
  runPublish,
).pipe(Command.withDescription("Publish a static site to a Scratchwork server"));

const projectRefOptions = {
  server: Options.text("server").pipe(
    Options.withDefault(""),
    Options.withDescription("Scratchwork server URL"),
  ),
  workspace: Options.text("workspace").pipe(
    Options.withDefault(""),
    Options.withDescription("Workspace name"),
  ),
  project: Options.text("project").pipe(
    Options.withDefault(""),
    Options.withDescription("Project name"),
  ),
  pathOrUrl: pathArg("path-or-url"),
};

const loginCommand = Command.make(
  "login",
  {
    serverArg: Args.text({ name: "server" }).pipe(Args.withDefault("")),
    server: Options.text("server").pipe(
      Options.withDefault(""),
      Options.withDescription("Scratchwork server URL"),
    ),
  },
  ({ serverArg, server }) => runLogin({ server: serverArg || server }),
).pipe(Command.withDescription("Authenticate with a Scratchwork server"));

const meCommand = Command.make(
  "me",
  {
    server: Options.text("server").pipe(Options.withDefault("")),
  },
  runMe,
).pipe(Command.withDescription("Print the current authenticated user"));

const projectsCommand = Command.make(
  "projects",
  {
    server: Options.text("server").pipe(Options.withDefault("")),
  },
  runProjects,
).pipe(Command.withDescription("List my projects"));

const infoCommand = Command.make("info", projectRefOptions, runInfo).pipe(
  Command.withDescription("Show project info"),
);

const unpublishCommand = Command.make("unpublish", projectRefOptions, runUnpublish).pipe(
  Command.withDescription("Make a project private"),
);

const deleteCommand = Command.make("delete", projectRefOptions, runDelete).pipe(
  Command.withDescription("Delete a project"),
);

const cloneCommand = Command.make(
  "clone",
  {
    pathOrUrl: pathArg("path-or-url"),
  },
  runClone,
).pipe(Command.withDescription("Clone a project"));

const streamCommand = Command.make(
  "stream",
  {
    path: pathArg("path"),
  },
  runStream,
).pipe(Command.withDescription("Stream edits to an existing project"));

const versionCommand = Command.make("version", {}, () =>
  Console.log(pkg.version),
).pipe(Command.withDescription("Print the version"));

const scratchworkCommand = Command.make("scratchwork").pipe(
  Command.withDescription("CLI for Scratchwork projects"),
  Command.withSubcommands([
    cloneCommand,
    deleteCommand,
    devCommand,
    exampleCommand,
    infoCommand,
    loginCommand,
    meCommand,
    projectsCommand,
    publishCommand,
    streamCommand,
    templateCommand,
    unpublishCommand,
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
