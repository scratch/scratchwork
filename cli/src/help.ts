export interface HelpResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

interface CommandHelp {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly arguments?: ReadonlyArray<HelpItem>;
  readonly options?: ReadonlyArray<HelpItem>;
  readonly notes?: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<string>;
}

interface HelpItem {
  readonly label: string;
  readonly description: string;
  readonly details?: ReadonlyArray<string>;
}

const COMMANDS: ReadonlyArray<CommandHelp> = [
  {
    name: "dev",
    summary: "Serve a Scratchwork project locally with hot reload.",
    usage: "scratchwork dev [path] [-p <port>] [--verbose]",
    arguments: [
      {
        label: "path",
        description: "File or directory to serve.",
        details: ["Default: current directory. Passing a file opens that file's route."],
      },
    ],
    options: [
      {
        label: "-p, --port <port>",
        description: "Starting port for the local server.",
        details: ["Default: 3000. If the port is busy, Scratchwork probes upward."],
      },
      {
        label: "--verbose",
        description: "Print Effect debug logs for server startup and routing decisions.",
      },
    ],
    notes: [
      "Opens the served URL in your browser unless SCRATCHWORK_NO_OPEN=1 is set.",
      "Serves Markdown through the nearest Scratchwork renderer shell, with live reload for .md, .html, .js, and .css changes.",
    ],
    examples: [
      "scratchwork dev",
      "scratchwork dev docs --port 4000",
      "SCRATCHWORK_NO_OPEN=1 scratchwork dev .",
    ],
  },
  {
    name: "example",
    summary: "Write a small Markdown project with sample components.",
    usage: "scratchwork example [path]",
    arguments: [
      {
        label: "path",
        description: "Destination directory for the example project.",
        details: ["Default: current directory."],
      },
    ],
    notes: ["Refuses to overwrite existing example files."],
    examples: [
      "scratchwork example demo",
      "cd demo && scratchwork dev",
    ],
  },
  {
    name: "template",
    summary: "Write the default Scratchwork Markdown renderer HTML.",
    usage: "scratchwork template [file]",
    arguments: [
      {
        label: "file",
        description: "Output HTML file.",
        details: ["Default: index.html."],
      },
    ],
    notes: ["Refuses to overwrite an existing file."],
    examples: [
      "scratchwork template",
      "scratchwork template docs/index.html",
    ],
  },
  {
    name: "publish",
    summary: "Publish a static Scratchwork project to a server.",
    usage: "scratchwork publish [path] --server <url> [--workspace <name>] [--project <name>] [--visibility <scope>]",
    arguments: [
      {
        label: "path",
        description: "File or directory to publish.",
        details: ["Default: current directory. Directories are uploaded recursively, excluding .git, node_modules, and .scratchwork-data."],
      },
    ],
    options: [
      {
        label: "--server <url>",
        description: "Scratchwork app server, such as sndbx.sh or https://app.sndbx.sh.",
        details: ["Required on first publish; later reads from .scratchwork.json."],
      },
      {
        label: "--workspace <name>",
        description: "Workspace/owner segment for the published URL.",
        details: ["Default: saved config, your login email prefix, or default."],
      },
      {
        label: "--project <name>",
        description: "Project name segment for the published URL.",
        details: ["Default: saved config or the published directory name."],
      },
      {
        label: "--visibility <scope>",
        description: "Access level for the publication.",
        details: ["Common values: private, public, an email address, or a domain group like @example.com. Default: private."],
      },
    ],
    notes: [
      "Writes .scratchwork.json after a successful publish so later project commands can omit server/workspace/project.",
      "If the server returns 401, the CLI starts scratchwork login and retries.",
    ],
    examples: [
      "scratchwork publish . --server sndbx.sh --visibility public",
      "scratchwork publish docs --server https://app.sndbx.sh --workspace koomen --project hello-world",
      "scratchwork publish --visibility private",
    ],
  },
  {
    name: "login",
    summary: "Authenticate this machine with a Scratchwork server.",
    usage: "scratchwork login <server>\n  scratchwork login --server <url>",
    arguments: [
      {
        label: "server",
        description: "Scratchwork app server to authenticate with.",
        details: ["Naked public domains normalize to their app subdomain, for example sndbx.sh -> https://app.sndbx.sh."],
      },
    ],
    options: [
      {
        label: "--server <url>",
        description: "Server URL alternative to the positional server argument.",
      },
    ],
    notes: [
      "Starts a loopback callback server and opens the browser for Google OAuth.",
      "Stores the returned bearer token under SCRATCHWORK_HOME or ~/.scratchwork.",
    ],
    examples: [
      "scratchwork login sndbx.sh",
      "scratchwork login --server https://app.sndbx.sh",
    ],
  },
  {
    name: "me",
    summary: "Show the authenticated user for a server.",
    usage: "scratchwork me --server <url>",
    options: [
      {
        label: "--server <url>",
        description: "Scratchwork app server.",
        details: ["May be omitted inside a directory with .scratchwork.json."],
      },
    ],
    examples: [
      "scratchwork me --server sndbx.sh",
      "scratchwork me",
    ],
  },
  {
    name: "projects",
    summary: "List projects owned by the authenticated user.",
    usage: "scratchwork projects --server <url>",
    options: [
      {
        label: "--server <url>",
        description: "Scratchwork app server.",
        details: ["May be omitted inside a directory with .scratchwork.json."],
      },
    ],
    examples: [
      "scratchwork projects --server sndbx.sh",
      "scratchwork projects",
    ],
  },
  {
    name: "info",
    summary: "Show metadata for one published project.",
    usage: "scratchwork info [project-url-or-path] [--server <url>] [--workspace <name>] [--project <name>]",
    arguments: [
      {
        label: "project-url-or-path",
        description: "Published project URL or a local path containing .scratchwork.json.",
        details: ["Default: current directory."],
      },
    ],
    options: projectRefOptions(),
    notes: ["Explicit --workspace and --project override values found in .scratchwork.json or a URL."],
    examples: [
      "scratchwork info https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork info --server sndbx.sh --workspace koomen --project hello-world",
      "scratchwork info",
    ],
  },
  {
    name: "unpublish",
    summary: "Make a published project private.",
    usage: "scratchwork unpublish [project-url-or-path] [--server <url>] [--workspace <name>] [--project <name>]",
    arguments: [
      {
        label: "project-url-or-path",
        description: "Published project URL or a local path containing .scratchwork.json.",
        details: ["Default: current directory."],
      },
    ],
    options: projectRefOptions(),
    notes: ["This does not delete files or project metadata; it changes visibility to private."],
    examples: [
      "scratchwork unpublish https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork unpublish --server sndbx.sh --workspace koomen --project hello-world",
    ],
  },
  {
    name: "delete",
    summary: "Delete a project pointer and route from the server.",
    usage: "scratchwork delete [project-url-or-path] [--server <url>] [--workspace <name>] [--project <name>]",
    arguments: [
      {
        label: "project-url-or-path",
        description: "Published project URL or a local path containing .scratchwork.json.",
        details: ["Default: current directory."],
      },
    ],
    options: projectRefOptions(),
    notes: ["Requires project ownership. Use carefully; the route is removed from the server index."],
    examples: [
      "scratchwork delete https://pages.sndbx.sh/koomen/old-demo/",
      "scratchwork delete --server sndbx.sh --workspace koomen --project old-demo",
    ],
  },
  {
    name: "clone",
    summary: "Download a published project into a local directory.",
    usage: "scratchwork clone [project-url-or-path]",
    arguments: [
      {
        label: "project-url-or-path",
        description: "Published project URL or a local path containing .scratchwork.json.",
        details: ["Default: current directory. The destination directory is named after the project."],
      },
    ],
    notes: ["Uses stored login credentials for private projects."],
    examples: [
      "scratchwork clone https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork clone .",
    ],
  },
  {
    name: "stream",
    summary: "Publish once, then republish on local file changes.",
    usage: "scratchwork stream [path]",
    arguments: [
      {
        label: "path",
        description: "Local project directory to watch and publish.",
        details: ["Default: current directory. Requires .scratchwork.json or publish options saved from a previous publish."],
      },
    ],
    notes: ["Ignores node_modules and .scratchwork.json changes. Press Ctrl-C to stop."],
    examples: [
      "scratchwork stream",
      "scratchwork stream docs",
    ],
  },
  {
    name: "version",
    summary: "Print the Scratchwork CLI version.",
    usage: "scratchwork version",
    examples: [
      "scratchwork version",
      "scratchwork -v",
    ],
  },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export function printHelpIfRequested(
  argv: ReadonlyArray<string>,
  version: string,
): HelpResult {
  const args = argv.slice(2);
  const request = helpRequest(args);
  if (request == null) return { handled: false, exitCode: 0 };

  const text = request.command == null
    ? renderRootHelp(version)
    : renderCommandHelp(request.command, version);
  if (text == null) {
    console.error(`Unknown command: ${request.command}`);
    console.error("");
    console.error(renderRootHelp(version));
    return { handled: true, exitCode: 1 };
  }

  console.log(text);
  return { handled: true, exitCode: request.noCommand ? 1 : 0 };
}

function helpRequest(args: ReadonlyArray<string>): { readonly command?: string; readonly noCommand?: boolean } | null {
  if (args.length === 0) return { noCommand: true };
  const [first, second, ...rest] = args;
  if (first === "--help" || first === "-h") return { command: second };
  if (first === "help") return { command: second };
  // A bare "help" after the command is a positional argument (a path or project
  // name), not a help request; only flag forms trigger help there.
  if (second === "--help" || second === "-h") return { command: first };
  if (rest.includes("--help") || rest.includes("-h")) return { command: first };
  return null;
}

function renderRootHelp(version: string): string {
  const commandRows = COMMANDS.map((command) => ({
    label: command.name,
    description: command.summary,
  }));
  return [
    `scratchwork ${version}`,
    "",
    "Usage:",
    "  scratchwork <command> [options]",
    "  scratchwork help <command>",
    "",
    "Commands:",
    formatItems(commandRows),
    "",
    "Global:",
    formatItems([
      { label: "-h, --help", description: "Show help for the root command or a subcommand." },
      { label: "-v, --version", description: "Print the CLI version." },
    ]),
    "",
    "Examples:",
    formatExamples([
      "scratchwork dev",
      "scratchwork publish . --server sndbx.sh --visibility public",
      "scratchwork projects --server sndbx.sh",
      "scratchwork help publish",
    ]),
  ].join("\n");
}

function renderCommandHelp(commandName: string, version: string): string | null {
  const command = COMMAND_BY_NAME.get(commandName);
  if (command == null) return null;
  const parts = [
    `scratchwork ${command.name} - ${command.summary}`,
    `scratchwork ${version}`,
    "",
    "Usage:",
    indent(command.usage),
  ];
  if (command.arguments != null && command.arguments.length > 0) {
    parts.push("", "Arguments:", formatItems(command.arguments));
  }
  if (command.options != null && command.options.length > 0) {
    parts.push("", "Options:", formatItems(command.options));
  }
  if (command.notes != null && command.notes.length > 0) {
    parts.push("", "Notes:", formatBullets(command.notes));
  }
  parts.push("", "Examples:", formatExamples(command.examples));
  return parts.join("\n");
}

function projectRefOptions(): ReadonlyArray<HelpItem> {
  return [
    {
      label: "--server <url>",
      description: "Scratchwork app server.",
      details: ["May be omitted when the project reference or .scratchwork.json provides it."],
    },
    {
      label: "--workspace <name>",
      description: "Workspace/owner name.",
    },
    {
      label: "--project <name>",
      description: "Project name.",
    },
  ];
}

function formatItems(items: ReadonlyArray<HelpItem>): string {
  const width = Math.min(Math.max(...items.map((item) => item.label.length)), 28);
  return items.map((item) => {
    const lines = [`  ${item.label.padEnd(width)}  ${item.description}`];
    for (const detail of item.details ?? []) {
      lines.push(`${" ".repeat(width + 4)}${detail}`);
    }
    return lines.join("\n");
  }).join("\n");
}

function formatBullets(items: ReadonlyArray<string>): string {
  return items.map((item) => `  - ${item}`).join("\n");
}

function formatExamples(examples: ReadonlyArray<string>): string {
  return examples.map((example) => `  ${example}`).join("\n");
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
