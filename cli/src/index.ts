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
import { runInstall, runUpdate } from "./commands/install";
import { runLogin } from "./commands/login";
import { DEFAULT_PORT, runDev } from "./commands/dev";
import { runPublish } from "./commands/publish";
import { runClone, runDelete, runInfo, runMe, runProjects, runRevoke, runShare, runStream, runUnpublish } from "./commands/projects";
import { runTemplate } from "./commands/template";
import * as ValidationError from "@effect/cli/ValidationError";
import { CliError } from "./errors";
import { printHelpIfRequested, printUnknownCommandIfFound } from "./help";

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
    project: textOption("project", "name", "Project name for the published URL. Default: saved config, the directory name, or the file name without its extension. Servers in random-naming mode assign a name on first publish."),
    isPublicFlag: Options.boolean("public").pipe(
      Options.withDescription("Make the project readable by everyone. Default: saved config, the project's current setting, or private for a new project. Grant per-account or per-domain access with scratchwork share."),
    ),
    isPrivateFlag: Options.boolean("private").pipe(
      Options.withDescription("Make the project readable only by its owner and share grants."),
    ),
  },
  ({ path, server, project, isPublicFlag, isPrivateFlag }) =>
    isPublicFlag && isPrivateFlag
      ? Effect.fail(new CliError({ code: 1, message: "scratchwork publish: pass at most one of --public and --private" }))
      : runPublish({ path, server, project, isPublic: isPublicFlag ? true : isPrivateFlag ? false : undefined }),
).pipe(Command.withDescription("Publish a static Scratchwork project to a server"));

const projectRefOptions = {
  server: textOption("server", "url", "Scratchwork app server. May be omitted when the project reference or .scratchwork.json provides it."),
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

/** Args/options shared by share and revoke: grant targets mixed with the project reference. */
const shareOptions = (verb: string) => ({
  server: textOption("server", "url", "Scratchwork app server. May be omitted when the project reference or .scratchwork.json provides it."),
  project: textOption("project", "name", "Project name. Overrides values from .scratchwork.json or a URL."),
  targets: Args.text({ name: "target" }).pipe(
    Args.repeated,
    Args.withDescription(`Email addresses or @domain groups to ${verb}, such as alice@example.com or @example.com. One target may instead be a published project URL or a local project path (anything without an "@").`),
  ),
});

const shareCommand = Command.make(
  "share",
  {
    ...shareOptions("grant access"),
    role: Options.choice("role", ["read", "write", "admin"]).pipe(
      Options.withDefault("read" as const),
      Options.withDescription("Permission level to assign: read (view the project), write (read + publish updates), or admin (write + manage sharing, the public/private toggle, and unpublish). Default: read. Sharing again with a different role moves the target; ownership stays with the project creator."),
    ),
  },
  runShare,
).pipe(Command.withDescription("Grant accounts or whole domains access to a project"));

const revokeCommand = Command.make("revoke", shareOptions("revoke"), runRevoke).pipe(
  Command.withDescription("Remove accounts' or domains' access to a project"),
);

const unpublishCommand = Command.make("unpublish", projectRefOptions, runUnpublish).pipe(
  Command.withDescription("Make a published project private"),
);

const deleteCommand = Command.make("delete", projectRefOptions, runDelete).pipe(
  Command.withDescription("Delete a project from the server, releasing its name"),
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

const installCommand = Command.make(
  "install",
  {
    dir: textOption("dir", "path", "Install destination directory. Default: SCRATCHWORK_INSTALL_DIR or ~/.local/bin."),
  },
  ({ dir }) => runInstall({ dir }),
).pipe(Command.withDescription("Install this scratchwork binary into a directory on your PATH"));

const updateCommand = Command.make("update", {}, () => runUpdate()).pipe(
  Command.withDescription("Update the scratchwork CLI to the latest release"),
);

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
    installCommand,
    loginCommand,
    meCommand,
    projectsCommand,
    publishCommand,
    revokeCommand,
    shareCommand,
    streamCommand,
    templateCommand,
    unpublishCommand,
    updateCommand,
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
  const normalizedArgv = normalizeArgv(argv);
  const preParse = [
    () => printHelpIfRequested(argv, pkg.version, scratchworkCommand),
    () => printUnknownCommandIfFound(normalizedArgv, scratchworkCommand),
  ];
  for (const check of preParse) {
    const result = check();
    if (result.handled) {
      process.exitCode = result.exitCode;
      return;
    }
  }

  Effect.suspend(() => cli(normalizedArgv)).pipe(
    Effect.catchAll((error) => {
      if (error instanceof CliError) {
        return (error.message ? Console.error(error.message) : Effect.void).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              process.exitCode = error.code;
            }),
          ),
        );
      }
      // @effect/cli already printed a readable message for parse failures;
      // swallow the error so runMain does not also dump it as raw JSON.
      if (ValidationError.isValidationError(error)) {
        return Effect.sync(() => {
          process.exitCode = 1;
        });
      }
      return Effect.fail(error);
    }),
    Effect.provide(MainLayer),
    BunRuntime.runMain,
  );
}

runScratchworkCli();
