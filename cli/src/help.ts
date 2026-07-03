/*
 * Custom help formatter for the scratchwork CLI.
 *
 * Command structure — names, summaries, arguments, options, and their
 * descriptions — is derived from the @effect/cli command graph declared in
 * index.ts, so help output cannot drift from the real CLI surface. Only
 * prose with no home in those declarations (notes and examples) lives here.
 *
 * The derivation walks @effect/cli descriptor internals (version pinned in
 * package.json); unknown node tags are skipped so a library update degrades
 * help output instead of breaking the CLI.
 */
import type { Command } from "@effect/cli/Command";

/** Whether argv was a help request, and the exit code to use if it was. */
export interface HelpResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

/** Everything the renderer needs to document one subcommand. */
interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  readonly args: ReadonlyArray<HelpItem>;
  readonly options: ReadonlyArray<OptionInfo>;
}

/** One aligned label/description row in a help listing. */
interface HelpItem {
  readonly label: string;
  readonly description: string;
}

interface OptionInfo extends HelpItem {
  /** Long-flag form shown in the usage line, such as `[--server <url>]`. */
  readonly usage: string;
}

/** Hand-written prose (notes, examples) that has no home in the command graph. */
interface CommandExtras {
  readonly notes?: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<string>;
}

const EXTRAS: Readonly<Record<string, CommandExtras>> = {
  dev: {
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
  example: {
    notes: ["Refuses to overwrite existing example files."],
    examples: [
      "scratchwork example demo",
      "cd demo && scratchwork dev",
    ],
  },
  template: {
    notes: ["Refuses to overwrite an existing file."],
    examples: [
      "scratchwork template",
      "scratchwork template docs/index.html",
    ],
  },
  publish: {
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
  login: {
    notes: [
      "Starts a loopback callback server and opens the browser for Google OAuth.",
      "Stores the returned bearer token under SCRATCHWORK_HOME or ~/.scratchwork.",
    ],
    examples: [
      "scratchwork login sndbx.sh",
      "scratchwork login --server https://app.sndbx.sh",
    ],
  },
  me: {
    examples: [
      "scratchwork me --server sndbx.sh",
      "scratchwork me",
    ],
  },
  projects: {
    examples: [
      "scratchwork projects --server sndbx.sh",
      "scratchwork projects",
    ],
  },
  info: {
    notes: ["Explicit --workspace and --project override values found in .scratchwork.json or a URL."],
    examples: [
      "scratchwork info https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork info --server sndbx.sh --workspace koomen --project hello-world",
      "scratchwork info",
    ],
  },
  unpublish: {
    notes: ["This does not delete files or project metadata; it changes visibility to private."],
    examples: [
      "scratchwork unpublish https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork unpublish --server sndbx.sh --workspace koomen --project hello-world",
    ],
  },
  delete: {
    notes: ["Requires project ownership. Use carefully; the route is removed from the server index."],
    examples: [
      "scratchwork delete https://pages.sndbx.sh/koomen/old-demo/",
      "scratchwork delete --server sndbx.sh --workspace koomen --project old-demo",
    ],
  },
  clone: {
    notes: ["Uses stored login credentials for private projects."],
    examples: [
      "scratchwork clone https://pages.sndbx.sh/koomen/hello-world/",
      "scratchwork clone .",
    ],
  },
  stream: {
    notes: ["Ignores node_modules and .scratchwork.json changes. Press Ctrl-C to stop."],
    examples: [
      "scratchwork stream",
      "scratchwork stream docs",
    ],
  },
  version: {
    examples: [
      "scratchwork version",
      "scratchwork -v",
    ],
  },
};

/**
 * Detects a help request in argv and, when found, prints the appropriate help
 * text and reports the exit code the process should use.
 */
export function printHelpIfRequested<Name extends string, R, E, A>(
  argv: ReadonlyArray<string>,
  version: string,
  root: Command<Name, R, E, A>,
): HelpResult {
  const args = argv.slice(2);
  const request = helpRequest(args);
  if (request == null) return { handled: false, exitCode: 0 };

  const commands = subcommandInfos(root);
  const text = request.command == null
    ? renderRootHelp(version, commands)
    : renderCommandHelp(version, commands.find((command) => command.name === request.command));
  if (text == null) {
    console.error(`Unknown command: ${request.command}`);
    console.error("");
    console.error(renderRootHelp(version, commands));
    return { handled: true, exitCode: 1 };
  }

  console.log(text);
  return { handled: true, exitCode: request.noCommand ? 1 : 0 };
}

/** Recognizes `--help`/`-h`/`help` forms in argv, or empty argv, as help requests. */
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders the top-level help screen listing every subcommand. */
function renderRootHelp(version: string, commands: ReadonlyArray<CommandInfo>): string {
  return [
    `scratchwork ${version}`,
    "",
    "Usage:",
    "  scratchwork <command> [options]",
    "  scratchwork help <command>",
    "",
    "Commands:",
    formatItems(commands.map((command) => ({ label: command.name, description: command.summary }))),
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

/** Renders one subcommand's help screen, or null for an unknown command. */
function renderCommandHelp(version: string, command: CommandInfo | undefined): string | null {
  if (command == null) return null;
  const extras = EXTRAS[command.name];
  const parts = [
    `scratchwork ${command.name} - ${command.summary}`,
    `scratchwork ${version}`,
    "",
    "Usage:",
    `  ${commandUsage(command)}`,
  ];
  if (command.args.length > 0) {
    parts.push("", "Arguments:", formatItems(command.args));
  }
  if (command.options.length > 0) {
    parts.push("", "Options:", formatItems(command.options));
  }
  if (extras?.notes != null && extras.notes.length > 0) {
    parts.push("", "Notes:", formatBullets(extras.notes));
  }
  if (extras != null && extras.examples.length > 0) {
    parts.push("", "Examples:", formatExamples(extras.examples));
  }
  return parts.join("\n");
}

/** Builds the one-line usage string for a command from its args and options. */
function commandUsage(command: CommandInfo): string {
  return [
    "scratchwork",
    command.name,
    ...command.args.map((arg) => `[${arg.label}]`),
    ...command.options.map((option) => option.usage),
  ].join(" ");
}

/** Formats label/description pairs into aligned, wrapped two-column rows. */
function formatItems(items: ReadonlyArray<HelpItem>): string {
  const width = Math.min(Math.max(...items.map((item) => item.label.length)), 28);
  return items.map((item) => {
    const [first = "", ...rest] = wrapText(item.description, 76);
    return [
      `  ${item.label.padEnd(width)}  ${first}`.trimEnd(),
      ...rest.map((line) => `${" ".repeat(width + 4)}${line}`),
    ].join("\n");
  }).join("\n");
}

/** Formats note lines as an indented bullet list. */
function formatBullets(items: ReadonlyArray<string>): string {
  return items.map((item) => `  - ${item}`).join("\n");
}

/** Formats example command lines with the standard indent. */
function formatExamples(examples: ReadonlyArray<string>): string {
  return examples.map((example) => `  ${example}`).join("\n");
}

/** Greedily wraps text at word boundaries to the given column width. */
function wrapText(text: string, columns: number): ReadonlyArray<string> {
  const lines: Array<string> = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((word) => word !== "")) {
    if (line !== "" && line.length + 1 + word.length > columns) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Deriving command structure from the @effect/cli command graph
// ---------------------------------------------------------------------------

/** Loosely-typed @effect/cli descriptor node; only `_tag` is guaranteed. */
type Node = { readonly _tag: string } & Record<string, any>;

/** Extracts name, summary, args, and options for every subcommand of the root. */
function subcommandInfos<Name extends string, R, E, A>(
  root: Command<Name, R, E, A>,
): ReadonlyArray<CommandInfo> {
  const descriptor = unwrapCommand(root.descriptor as unknown as Node);
  if (descriptor._tag !== "Subcommands" || !Array.isArray(descriptor.children)) return [];
  return descriptor.children
    .map((child: Node) => unwrapCommand(child))
    .filter((child: Node) => child._tag === "Standard")
    .map((standard: Node): CommandInfo => ({
      name: String(standard.name),
      summary: helpDocText(standard.description),
      args: collectSingles(standard.args, "args").map(argItem),
      options: collectSingles(standard.options, "options").map(optionInfo),
    }));
}

/** Peels Map wrappers added by handlers and description combinators. */
function unwrapCommand(node: Node): Node {
  let current = node;
  while (current._tag === "Map" && current.command != null) current = current.command;
  return current;
}

/** Flattens an options/args tree into its Single leaves, in declaration order. */
function collectSingles(node: Node | undefined, childKey: "args" | "options"): ReadonlyArray<Node> {
  if (node == null) return [];
  switch (node._tag) {
    case "Single":
      return [node];
    case "Map":
    case "WithDefault":
    case "WithFallbackConfig":
    case "Variadic":
      return collectSingles(node[childKey], childKey);
    case "Both":
      return [...collectSingles(node.left, childKey), ...collectSingles(node.right, childKey)];
    default:
      return [];
  }
}

/** Converts a Single argument descriptor into a help row. */
function argItem(single: Node): HelpItem {
  return {
    label: pseudoName(single) ?? String(single.name).replace(/[<>]/g, ""),
    description: helpDocText(single.description),
  };
}

/** Converts a Single option descriptor into a help row plus its usage form. */
function optionInfo(single: Node): OptionInfo {
  const aliases: ReadonlyArray<string> = Array.isArray(single.aliases) ? single.aliases : [];
  const flags = [
    ...aliases.map((alias: string) => alias.length === 1 ? `-${alias}` : `--${alias}`),
    String(single.fullName),
  ].join(", ");
  const isBoolean = single.primitiveType?._tag === "Bool";
  const value = isBoolean ? "" : ` <${pseudoName(single) ?? String(single.placeholder ?? "value")}>`;
  return {
    label: `${flags}${value}`,
    usage: `[${single.fullName}${value}]`,
    description: helpDocText(single.description),
  };
}

/** Reads a descriptor's display placeholder set via withPseudoName, if any. */
function pseudoName(single: Node): string | null {
  const pseudo = single.pseudoName;
  return typeof pseudo?.value === "string" ? pseudo.value : null;
}

/** Flattens an @effect/printer HelpDoc tree into plain text. */
function helpDocText(doc: Node | undefined): string {
  if (doc == null) return "";
  switch (doc._tag) {
    case "Header":
    case "Paragraph":
      return spanText(doc.value);
    case "Sequence":
      return [helpDocText(doc.left), helpDocText(doc.right)].filter((text) => text !== "").join(" ");
    default:
      return "";
  }
}

/** Flattens a HelpDoc span node into plain text. */
function spanText(span: Node | undefined): string {
  if (span == null) return "";
  switch (span._tag) {
    case "Text":
    case "URI":
      return String(span.value);
    case "Weak":
    case "Strong":
    case "Code":
      return spanText(span.value);
    case "Sequence":
      return spanText(span.left) + spanText(span.right);
    default:
      return "";
  }
}
