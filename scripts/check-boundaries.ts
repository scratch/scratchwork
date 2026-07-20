#!/usr/bin/env bun
/*
 * Mechanizes the checkable cores of invariants 1 and 2 (see AGENTS.md). Runs
 * first in the root `bun run ci` — it is pure static analysis and fails fast.
 *
 *  1. Effect-boundary lint: no `async` / `await` / `new Promise` / `.then(` /
 *     `Promise.*` in cli, server, or shared source outside the exact allowlist
 *     of boundary files below. A new boundary must be added to the allowlist
 *     with its rationale in the same PR; an entry whose file no longer trips
 *     the lint must be removed. The baseline may shrink, never grow silently.
 *  2. Import boundary: cli never imports server and vice versa (the only code
 *     importable by both is shared); shared imports neither; renderer/src is
 *     standalone plain browser JS and imports none of them.
 *  3. CLI API surface: the CLI reaches every JSON endpoint through the client
 *     derived from the shared HttpApi contract (ScratchworkApi in
 *     shared/src/publish/api.ts, consumed by cli/src/api.ts), so a route and
 *     its wire schemas cannot exist outside the contract. The only API-shaped
 *     URLs the CLI may build by hand are the browser navigations on the
 *     explicit allowlist below — any other /api/ or /auth/ literal in cli/src
 *     fails this check.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Invariant 1's reviewed boundary allowlist: the only files in scope allowed
 * to contain async/Promise constructs, each because the API it wraps
 * inherently returns Promises. Keep boundary files tiny — extract async
 * helpers into a dedicated module rather than allowlisting a large file.
 */
const ASYNC_BOUNDARIES: Readonly<Record<string, string>> = {
  "shared/src/crypto/digest.ts": "Web Crypto SHA-256 (crypto.subtle returns Promises); shared by CLI PKCE and server content hashing",
  "server/core/src/auth-crypto.ts": "Web Crypto HMAC + AES-GCM primitives behind the auth chokepoints",
  "server/core/src/jwt-rs256.ts": "Web Crypto RS256 JWT verification chokepoint",
  "server/core/src/google-jwt.ts": "Google OAuth token-endpoint POST + JWKS fetch — the identity-provider edge",
  "server/core/src/cloudflare-jwt.ts": "Cloudflare Access JWKS fetch — the identity-provider edge",
  "cli/src/commands/login-callback-server.ts": "Bun.serve loopback listener — platform entrypoint for the login callback",
  "server/deploy-aws/src/handler.ts": "AWS Lambda entrypoint — the platform's contract is Promise-based",
  "server/deploy-aws/src/s3-storage.ts": "AWS SDK S3 Promise APIs wrapped into the ObjectStorage service",
  "server/deploy-aws/src/deploy.ts": "deploy tooling — deliberately plain Promise-based script code (runs once on a developer's machine)",
  "server/deploy-cloudflare/src/worker.ts": "Workers fetch() entrypoint — the platform's contract is Promise-based",
  "server/deploy-cloudflare/src/local-worker.ts": "local wrapper around the Workers fetch() entrypoint",
  "server/deploy-cloudflare/src/r2-storage.ts": "Cloudflare R2 binding Promise APIs wrapped into the ObjectStorage service",
  "server/deploy-cloudflare/src/d1-db.ts": "Cloudflare D1 binding Promise APIs wrapped into the PrimitiveDb service",
  "server/deploy-cloudflare/src/deploy.ts": "deploy tooling — deliberately plain Promise-based script code (runs once on a developer's machine)",
};

/**
 * Invariant 2's allowlist of API-shaped URLs the CLI may build by hand: only
 * browser navigations, which redirect rather than answer JSON, and so have no
 * wire schema to share. Every JSON call must go through the contract-derived
 * client instead. A stale entry for a URL no longer built fails this check.
 */
const CLI_URL_ALLOWLIST: ReadonlyArray<{ route: string; file: string; note: string }> = [
  { route: "/auth/login", file: "cli/src/auth.ts", note: "browser navigation that starts the login flow; redirects, not JSON" },
];

const failures: string[] = [];

/** One string literal as the lexer saw it. For a template literal, `value` is
 * the raw text up to the first interpolation and `template` is true. */
interface StringLiteral {
  readonly value: string;
  readonly line: number;
  readonly template: boolean;
}

/** The three views of a source file the checks below consume. */
interface LexedSource {
  /** Source with comments blanked, strings kept — for import/call-site regexes. */
  readonly code: string;
  /** Source with comments and string contents blanked — for keyword scans that
   * must not be fooled by prose in comments or error messages. Code
   * interpolated inside template literals stays visible. */
  readonly codeOnly: string;
  /** Every string literal, so path-shaped strings can be told apart from
   * path-shaped prose embedded inside longer messages. */
  readonly strings: readonly StringLiteral[];
}

/**
 * A line-structure-preserving lexer for the subset of TS/JS these checks
 * need: comments, the three string forms, and template interpolation. Regex
 * literals are not modeled: an unescaped `//` or quote can only reach this
 * scanner from inside a regex character class, which does not occur in scope.
 */
function lex(source: string): LexedSource {
  const code = [...source];
  const codeOnly = [...source];
  const strings: StringLiteral[] = [];
  const blankComment = (i: number) => {
    if (source[i] !== "\n") {
      code[i] = " ";
      codeOnly[i] = " ";
    }
  };
  const blankString = (i: number) => {
    if (source[i] !== "\n") codeOnly[i] = " ";
  };
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let line = 1;
  let literalStart = -1;
  let literalLine = 1;
  const endLiteral = (end: number, template: boolean) => {
    strings.push({ value: source.slice(literalStart, end), line: literalLine, template });
  };
  // Per enclosing template literal: how deep `{` nesting is inside its ${ }.
  const interpolation: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "\n") line++;
    switch (mode) {
      case "code":
        if (c === "/" && (n === "/" || n === "*")) {
          blankComment(i);
          blankComment(i + 1);
          mode = n === "/" ? "line" : "block";
          i++;
        } else if (c === "'" || c === '"' || c === "`") {
          mode = c === "'" ? "single" : c === '"' ? "double" : "template";
          literalStart = i + 1;
          literalLine = line;
        } else if (c === "{" && interpolation.length > 0) interpolation[interpolation.length - 1]++;
        else if (c === "}" && interpolation.length > 0) {
          if (interpolation[interpolation.length - 1] === 0) {
            interpolation.pop();
            mode = "template";
            // The tail after an interpolation is not recorded as a literal;
            // route scanning only needs the head chunk.
            literalStart = -1;
          } else interpolation[interpolation.length - 1]--;
        }
        break;
      case "line":
        if (c === "\n") mode = "code";
        else blankComment(i);
        break;
      case "block":
        if (c === "*" && n === "/") {
          blankComment(i);
          blankComment(i + 1);
          i++;
          mode = "code";
        } else blankComment(i);
        break;
      case "single":
      case "double":
        if (c === "\\") {
          blankString(i);
          blankString(i + 1);
          if (n === "\n") line++;
          i++;
        } else if (c === (mode === "single" ? "'" : '"')) {
          endLiteral(i, false);
          mode = "code";
        } else if (c === "\n") mode = "code";
        else blankString(i);
        break;
      case "template":
        if (c === "\\") {
          blankString(i);
          blankString(i + 1);
          if (n === "\n") line++;
          i++;
        } else if (c === "`") {
          if (literalStart >= 0) endLiteral(i, true);
          mode = "code";
        } else if (c === "$" && n === "{") {
          if (literalStart >= 0) endLiteral(i, true);
          literalStart = -1;
          interpolation.push(0);
          i++;
          mode = "code";
        } else blankString(i);
        break;
    }
  }
  return { code: code.join(""), codeOnly: codeOnly.join(""), strings };
}

/** Expands glob patterns from the repo root, excluding generated and declaration files. */
function sources(patterns: string[]): string[] {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      if (file.includes("node_modules/") || file.includes("dist/")) continue;
      if (file.endsWith(".d.ts") || file.endsWith(".generated.js")) continue;
      files.add(file);
    }
  }
  return [...files].sort();
}

const read = (file: string) => readFileSync(join(root, file), "utf8");

// ─── 1. Effect-boundary lint ────────────────────────────────────────────────

const BANNED: ReadonlyArray<{ token: string; re: RegExp }> = [
  { token: "async", re: /(?<![.\w$])async\b/ },
  { token: "await", re: /(?<![.\w$])await\b/ },
  { token: "new Promise", re: /(?<![.\w$])new\s+Promise\b/ },
  { token: ".then(", re: /\.then\s*\(/ },
  { token: "Promise.", re: /(?<![.\w$])Promise\s*\./ },
];

const effectScope = sources(["cli/src/**/*.ts", "server/*/src/**/*.ts", "shared/src/**/*.{ts,js}"]);
const boundariesSeen = new Set<string>();
for (const file of effectScope) {
  const code = lex(read(file)).codeOnly;
  const hits: string[] = [];
  code.split("\n").forEach((line, index) => {
    for (const { token, re } of BANNED) {
      if (re.test(line)) hits.push(`${file}:${index + 1}: ${token}`);
    }
  });
  if (hits.length === 0) continue;
  if (file in ASYNC_BOUNDARIES) {
    boundariesSeen.add(file);
    continue;
  }
  failures.push(
    `Effect-boundary lint (invariant 1): ${file} uses Promise constructs outside the allowlist:\n` +
      hits.map((hit) => `  ${hit}`).join("\n") +
      "\n  Make it Effect-native, or — only if it wraps an inherently Promise-based API — add it to\n" +
      "  ASYNC_BOUNDARIES in scripts/check-boundaries.ts with its rationale, in the same PR.",
  );
}
for (const file of Object.keys(ASYNC_BOUNDARIES)) {
  if (!effectScope.includes(file)) {
    failures.push(`Effect-boundary lint: allowlist entry ${file} does not exist — remove it.`);
  } else if (!boundariesSeen.has(file)) {
    failures.push(
      `Effect-boundary lint: ${file} no longer uses Promise constructs — remove its allowlist entry (the baseline may shrink, never grow silently).`,
    );
  }
}

// ─── 2. Import boundary ─────────────────────────────────────────────────────

const FORBIDDEN_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  cli: ["server"],
  server: ["cli"],
  shared: ["cli", "server"],
  renderer: ["cli", "server", "shared"],
};

/** Maps a repo-relative path or package specifier to its top-level zone. */
function zoneOf(target: string): string | null {
  if (target === "@scratchwork/shared" || target.startsWith("@scratchwork/shared/")) return "shared";
  if (target.startsWith("@scratchwork/server-")) return "server";
  if (target === "scratchwork-cli") return "cli";
  if (target === "scratchwork-renderer") return "renderer";
  for (const zone of Object.keys(FORBIDDEN_IMPORTS)) {
    if (target === zone || target.startsWith(`${zone}/`)) return zone;
  }
  return null;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
// renderer scope is src only: renderer/test may exercise shared parity checks,
// but the shipped renderer sources must stay standalone.
const importScope = sources([
  "cli/**/*.{ts,js}",
  "server/**/*.{ts,js}",
  "shared/**/*.{ts,js}",
  "renderer/src/**/*.js",
]);
for (const file of importScope) {
  const zone = zoneOf(file);
  if (zone == null) continue;
  const banned = FORBIDDEN_IMPORTS[zone] ?? [];
  const code = lex(read(file)).code;
  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1];
    const target = spec.startsWith(".")
      ? relative(root, resolve(join(root, dirname(file)), spec))
      : spec;
    if (target.startsWith("..")) continue;
    const targetZone = zoneOf(target);
    if (targetZone != null && targetZone !== zone && banned.includes(targetZone)) {
      failures.push(
        `Import boundary (invariant 2): ${file} imports "${spec}" (${targetZone}); ${zone} must not import ${targetZone}.` +
          (zone === "cli" || zone === "server" ? " Hoist shared code into shared/." : ""),
      );
    }
  }
}

// ─── 3. CLI API surface ─────────────────────────────────────────────────────

const cliSources = sources(["cli/src/**/*.ts"]);
const allowlistSeen = new Set<string>();
for (const file of cliSources) {
  const lexed = lex(read(file));
  // Path-shaped string literals (catches raw fetches too). Every JSON route
  // lives in the shared contract, so cli/src may only hand-build the browser
  // navigations on the allowlist.
  for (const literal of lexed.strings) {
    if (!/^\/(?:api|auth)(?:\/|$)/.test(literal.value)) continue;
    const allowed = CLI_URL_ALLOWLIST.find((entry) => entry.route === literal.value && entry.file === file);
    if (allowed != null) {
      allowlistSeen.add(allowed.route);
      continue;
    }
    failures.push(
      `CLI API surface (invariant 2): ${file}:${literal.line} hand-builds the URL "${literal.value}". Declare the\n` +
        "  endpoint on ScratchworkApi in shared/src/publish/api.ts and call it through the derived client\n" +
        "  (apiClient in cli/src/api.ts), or — only for a browser navigation — add it to CLI_URL_ALLOWLIST\n" +
        "  in scripts/check-boundaries.ts with its rationale, in the same PR.",
    );
  }
}
for (const entry of CLI_URL_ALLOWLIST) {
  if (!allowlistSeen.has(entry.route)) {
    failures.push(`CLI API surface: "${entry.route}" is no longer built in ${entry.file} — remove its stale allowlist entry.`);
  }
}

// The contract object both sides derive from must exist, define endpoints,
// and be what the CLI's client module actually consumes.
const sharedApi: Record<string, unknown> = await import(join(root, "shared/src/publish/api.ts"));
const contract = sharedApi.ScratchworkApi as { groups?: Record<string, { endpoints: Record<string, unknown> }> } | undefined;
const contractEndpoints = Object.values(contract?.groups ?? {}).flatMap((group) => Object.keys(group.endpoints));
if (contractEndpoints.length === 0) {
  failures.push("CLI API surface: shared/src/publish/api.ts no longer exports the ScratchworkApi contract with endpoints.");
}
if (!/\bScratchworkApi\b/.test(lex(read("cli/src/api.ts")).code)) {
  failures.push("CLI API surface: cli/src/api.ts no longer derives its client from the shared ScratchworkApi contract.");
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`check-boundaries: ${failures.length} violation(s)\n`);
  for (const failure of failures) console.error(failure + "\n");
  process.exit(1);
}
console.log(
  `check-boundaries: ${effectScope.length} files Effect-clean (${boundariesSeen.size} reviewed boundaries), ` +
    `${importScope.length} files respect import boundaries, ${contractEndpoints.length} contract endpoints drive the CLI API surface.`,
);
