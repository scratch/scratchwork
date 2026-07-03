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
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import pkg from "../package.json";
import { runExample } from "./commands/example";
import { runLogin } from "./commands/login";
import { DEFAULT_PORT, runDev } from "./commands/dev";
import { runPublish } from "./commands/publish";
import { runClone, runDelete, runInfo, runMe, runProjects, runStream, runUnpublish } from "./commands/projects";
import { runTemplate } from "./commands/template";
import { CliError } from "./errors";
import { printHelpIfRequested } from "./help";

/** Declares a positional path argument with a default and help text. */
const pathArg = (name: string, fallback: string, description: string) =>
  Args.text({ name }).pipe(Args.withDefault(fallback), Args.withDescription(description));

/** Declares an optional text flag that reads as `undefined` when omitted. */
const textOption = (name: string, pseudoName: string, description: string) =>
  Options.text(name).pipe(
    Options.optional,
    Options.map(Option.getOrUndefined),
    Options.withPseudoName(pseudoName),
    Options.withDescription(description),
  );

// ---------------------------------------------------------------------------
// Top-level project commands
// ---------------------------------------------------------------------------
const devCommand = Command.make(
  "dev",
  {
    path: pathArg("path", ".", "File or directory to serve. Default: current directory; passing a file opens that file's route."),
    port: Options.integer("port").pipe(
      Options.withAlias("p"),
      Options.withDefault(DEFAULT_PORT),
      Options.withPseudoName("port"),
      Options.withDescription("Starting port for the local server. Default: 3000; if the port is busy, Scratchwork probes upward."),
    ),
    verbose: Options.boolean("verbose").pipe(
      Options.withDescription("Print Effect debug logs for server startup and routing decisions."),
    ),
  },
  runDev,
).pipe(Command.withDescription("Serve a Scratchwork project locally with hot reload"));

const exampleCommand = Command.make(
  "example",
  {
    path: pathArg("path", ".", "Destination directory for the example project. Default: current directory."),
  },
  runExample,
).pipe(Command.withDescription("Write a small Markdown project with sample components"));

const templateCommand = Command.make(
  "template",
  {
    file: pathArg("file", "index.html", "Output HTML file. Default: index.html."),
  },
  runTemplate,
).pipe(Command.withDescription("Write the default Scratchwork Markdown renderer HTML"));

const publishCommand = Command.make(
  "publish",
  {
    path: pathArg("path", ".", "File or directory to publish. Default: current directory. Directories are uploaded recursively, excluding .git, node_modules, and .scratchwork-data."),
    server: textOption("server", "url", "Scratchwork app server, such as sndbx.sh or https://app.sndbx.sh. Required on first publish; later publishes read it from .scratchwork.json."),
    workspace: textOption("workspace", "name", "Workspace/owner segment for the published URL. Default: saved config, or the server's default workspace policy."),
    project: textOption("project", "name", "Project name segment for the published URL. Default: saved config or the published directory name."),
    visibility: textOption("visibility", "scope", "Access level: private, public, an email address, or a domain group like @example.com. Default: saved config, the project's current visibility, or the server default."),
  },
  runPublish,
).pipe(Command.withDescription("Publish a static Scratchwork project to a server"));

const projectRefOptions = {
  server: textOption("server", "url", "Scratchwork app server. May be omitted when the project reference or .scratchwork.json provides it."),
  workspace: textOption("workspace", "name", "Workspace/owner name. Overrides values from .scratchwork.json or a URL."),
  project: textOption("project", "name", "Project name. Overrides values from .scratchwork.json or a URL."),
  pathOrUrl: pathArg("path-or-url", ".", "Published project URL or a local path containing .scratchwork.json. Default: current directory."),
};

const loginCommand = Command.make(
  "login",
  {
    serverArg: Args.text({ name: "server" }).pipe(
      Args.optional,
      Args.withDescription("Scratchwork app server to authenticate with. Naked public domains normalize to their app subdomain, for example sndbx.sh -> https://app.sndbx.sh."),
    ),
    server: textOption("server", "url", "Server URL alternative to the positional server argument."),
  },
  ({ serverArg, server }) => runLogin({ server: Option.getOrUndefined(serverArg) ?? server }),
).pipe(Command.withDescription("Authenticate this machine with a Scratchwork server"));

const serverOption = textOption("server", "url", "Scratchwork app server. May be omitted inside a directory with .scratchwork.json.");

const meCommand = Command.make(
  "me",
  {
    server: serverOption,
  },
  runMe,
).pipe(Command.withDescription("Show the authenticated user for a server"));

const projectsCommand = Command.make(
  "projects",
  {
    server: serverOption,
  },
  runProjects,
).pipe(Command.withDescription("List projects owned by the authenticated user"));

const infoCommand = Command.make("info", projectRefOptions, runInfo).pipe(
  Command.withDescription("Show metadata for one published project"),
);

const unpublishCommand = Command.make("unpublish", projectRefOptions, runUnpublish).pipe(
  Command.withDescription("Make a published project private"),
);

const deleteCommand = Command.make("delete", projectRefOptions, runDelete).pipe(
  Command.withDescription("Delete a project pointer and route from the server"),
);

const cloneCommand = Command.make(
  "clone",
  {
    pathOrUrl: pathArg("path-or-url", ".", "Published project URL or a local path containing .scratchwork.json. Default: current directory. The destination directory is named after the project."),
  },
  runClone,
).pipe(Command.withDescription("Download a published project into a local directory"));

const streamCommand = Command.make(
  "stream",
  {
    path: pathArg("path", ".", "Local project directory to watch and publish. Default: current directory. Requires .scratchwork.json from a previous publish."),
  },
  runStream,
).pipe(Command.withDescription("Publish once, then republish on local file changes"));

const versionCommand = Command.make("version", {}, () =>
  Console.log(pkg.version),
).pipe(Command.withDescription("Print the Scratchwork CLI version"));

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

/** Rewrites the `-v` shorthand to `--version` before @effect/cli parses argv. */
function normalizeArgv(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  if (argv.length < 3) return argv;
  const normalized = [...argv];
  if (normalized[2] === "-v") normalized[2] = "--version";
  return normalized;
}

const cli = Command.run(scratchworkCommand, {
  name: "scratchwork",
  version: pkg.version,
});

/** Services every command may use: CLI config, the Bun runtime context, and an HTTP client. */
const MainLayer = Layer.mergeAll(
  CliConfig.layer({ showBuiltIns: false }),
  BunHttpServer.layerContext,
  FetchHttpClient.layer,
);

/**
 * Runs the CLI: renders help requests without booting the Effect runtime,
 * otherwise executes the command graph and adapts CliError failures into
 * stderr messages and process exit codes.
 */
function runScratchworkCli(argv: ReadonlyArray<string> = process.argv): void {
  const help = printHelpIfRequested(argv, pkg.version, scratchworkCommand);
  if (help.handled) {
    process.exitCode = help.exitCode;
    return;
  }

  Effect.suspend(() => cli(normalizeArgv(argv))).pipe(
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
