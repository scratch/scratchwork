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
import { runCreate } from "./commands/create";
import { DEFAULT_PORT, runDev } from "./commands/dev";
import { runEject } from "./commands/eject";
import { runPublish } from "./commands/publish";
import { runShareCreate, runShareList, runShareRevoke } from "./commands/share";
import {
  runTokenCreate,
  runTokenList,
  runTokenRevoke,
  runTokenUse,
} from "./commands/tokens";
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

const optionalArg = (name: string) =>
  Args.text({ name }).pipe(Args.withDefault(null));

const optionalText = (name: string) =>
  Options.text(name).pipe(Options.withDefault(null));

const serverOption = () =>
  optionalText("server").pipe(
    Options.withDescription(
      `Server URL (default: project config, then ${cfg.DEFAULT_SERVER})`,
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

const publishCommand = Command.make(
  "publish",
  {
    path: pathArg("path"),
    server: serverOption(),
    name: optionalText("name").pipe(Options.withDescription("Project name")),
    visibility: optionalText("visibility").pipe(
      Options.withDescription(
        "Accounts visibility: public, private, @domain.com, email@x.com, or comma-separated",
      ),
    ),
    private: Options.boolean("private").pipe(
      Options.withDescription("Publish privately on accounts servers"),
    ),
    unlisted: Options.boolean("unlisted").pipe(
      Options.withDescription("Mark the project unlisted on legacy servers"),
    ),
    noOpen: Options.boolean("no-open").pipe(
      Options.withAlias("n"),
      Options.withDescription("Do not open the published URL in a browser"),
    ),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDescription("Show what would be uploaded without uploading"),
    ),
  },
  handler(runPublish),
).pipe(
  Command.withDescription("Publish a static site to a Scratchwork server"),
);

const createCommand = Command.make(
  "create",
  {
    path: pathArg("path"),
  },
  runCreate,
).pipe(Command.withDescription("Scaffold a new Scratchwork project"));

const ejectCommand = Command.make(
  "eject",
  {
    file: pathArg("file", "index.html"),
  },
  runEject,
).pipe(Command.withDescription("Write the default markdown renderer"));

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

// ---------------------------------------------------------------------------
// Token subcommands
// ---------------------------------------------------------------------------
const tokenListCommand = Command.make(
  "list",
  {
    server: serverOption(),
  },
  handler(runTokenList),
).pipe(Command.withDescription("List your API tokens"));

const tokenCreateCommand = Command.make(
  "create",
  {
    name: Args.text({ name: "name" }).pipe(Args.withDescription("Token name")),
    server: serverOption(),
    expires: Options.integer("expires").pipe(
      Options.withDefault(null),
      Options.withDescription("Days until expiry"),
    ),
  },
  handler(runTokenCreate),
).pipe(Command.withDescription("Create an API token"));

const tokenRevokeCommand = Command.make(
  "revoke",
  {
    id: Args.text({ name: "id" }).pipe(
      Args.withDescription("Token id or name"),
    ),
    server: serverOption(),
  },
  handler(runTokenRevoke),
).pipe(Command.withDescription("Revoke an API token"));

const tokenUseCommand = Command.make(
  "use",
  {
    token: Args.text({ name: "token" }).pipe(
      Args.withDescription("Existing scratchwork_ API token"),
    ),
    server: serverOption(),
  },
  handler(runTokenUse),
).pipe(Command.withDescription("Store an existing API token"));

const tokensCommand = Command.make("tokens").pipe(
  Command.withDescription("Manage API tokens for CI"),
  Command.withSubcommands([
    tokenListCommand,
    tokenCreateCommand,
    tokenRevokeCommand,
    tokenUseCommand,
  ]),
);

// ---------------------------------------------------------------------------
// Share-link subcommands
// ---------------------------------------------------------------------------
const shareCreateCommand = Command.make(
  "create",
  {
    project: optionalArg("project"),
    server: serverOption(),
    name: optionalText("name").pipe(
      Options.withDescription("Share link label"),
    ),
    duration: Options.text("duration").pipe(
      Options.withDefault("1w"),
      Options.withDescription("Duration such as 1d, 1w, or 1m"),
    ),
  },
  handler(runShareCreate),
).pipe(Command.withDescription("Create a share link"));

const shareListCommand = Command.make(
  "list",
  {
    project: optionalArg("project"),
    server: serverOption(),
  },
  handler(runShareList),
).pipe(Command.withDescription("List a project's share links"));

const shareRevokeCommand = Command.make(
  "revoke",
  {
    id: Args.text({ name: "tokenId" }).pipe(
      Args.withDescription("Share token id"),
    ),
    project: optionalArg("project"),
    server: serverOption(),
  },
  handler(runShareRevoke),
).pipe(Command.withDescription("Revoke a share link"));

const shareCommand = Command.make("share").pipe(
  Command.withDescription("Manage revocable share links"),
  Command.withSubcommands([
    shareCreateCommand,
    shareListCommand,
    shareRevokeCommand,
  ]),
);

const versionCommand = Command.make("version", {}, () =>
  Effect.sync(() => console.log(pkg.version)),
).pipe(Command.withDescription("Print the version"));

const scratchworkCommand = Command.make("scratchwork").pipe(
  Command.withDescription("CLI for Scratchwork projects"),
  Command.withSubcommands([
    devCommand,
    publishCommand,
    createCommand,
    ejectCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    tokensCommand,
    shareCommand,
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
