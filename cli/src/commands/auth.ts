import {
  whoami as apiWhoami,
  getCurrentUser,
} from "../lib/server-client";
import * as FileSystem from "@effect/platform/FileSystem";
import type { PlatformError } from "@effect/platform/Error";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { waitForCallback, generateCallbackState, generateCliCode, LOCALHOST_CALLBACK_PORT } from "../lib/auth-callback";
import * as cfg from "../lib/config";
import { openBrowser } from "../browser";
import { CliError, errorMessage } from "../errors";
import type { Auth, AuthType, CallbackResult, LoginConfig, ServerConfig, User, WhoamiResult } from "../types";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Read a single line from stdin (used to collect a token interactively).
function promptLine(question: string): Effect.Effect<string> {
  return Effect.tryPromise({
    try: () => {
      const rl = createInterface({ input, output });
      return rl.question(question).finally(() => rl.close());
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed("")));
}

// `scratchwork login [--server URL] [--token TOKEN]`
//
// On an accounts-mode server: opens the browser, you approve, and a per-user
// session token is stored. On a legacy single-token server (or with --token):
// stores the pasted token. Open servers need no login.
export function runLogin({ server: serverFlag = null, token: tokenFlag = null }: LoginConfig = {}): Effect.Effect<
  void,
  PlatformError | CliError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const serverUrl = yield* cfg.resolveServerUrl({ flag: serverFlag });
    const info = yield* apiWhoami({ serverUrl, auth: null }).pipe(
      Effect.catchAll((error) => failCommand(`scratchwork login: ${errorMessage(error)}`)),
    );

    if (!info.authRequired) {
      yield* Console.log(`\n  ${serverUrl} is open — no login needed.\n`);
      return;
    }

    // Explicit token paste (escape hatch / legacy / CI).
    const pasted = tokenFlag || process.env.SCRATCHWORK_TOKEN;
    if (pasted || info.mode !== "accounts") {
      const token = (pasted || (yield* promptLine(`Paste your token for ${serverUrl}: `))).trim();
      if (!token) {
        return yield* failCommand("scratchwork login: no token provided");
      }
      const type: AuthType = token.startsWith("scratchwork_") ? "api_key" : info.mode === "accounts" ? "session" : "bearer";
      const verify = yield* apiWhoami({ serverUrl, auth: { token, type } }).pipe(
        Effect.catchAll((error) => failCommand(`scratchwork login: ${errorMessage(error)}`)),
      );
      if (!verify.authenticated) {
        return yield* failCommand("scratchwork login: that token was not accepted by the server");
      }
      yield* cfg.saveCredentials(serverUrl, { token, type });
      yield* Console.log(`\n  Logged in to ${serverUrl}\n`);
      return;
    }

    const result = yield* browserLogin(serverUrl);
    yield* saveSession(serverUrl, result);
  });
}

function browserLogin(serverUrl: string): Effect.Effect<CallbackResult, CliError> {
  return Effect.gen(function* () {
    // Browser login (accounts mode). Show a verification code, open the browser,
    // and wait for the server to hand the session token back to localhost.
    const state = generateCallbackState();
    const code = generateCliCode();
    const loginUrl = `${serverUrl.replace(/\/+$/, "")}/cli-login?state=${state}&code=${code}`;
    yield* Console.log(
      [
        `\n  Your verification code:  ${code}`,
        "\n  Opening the browser to log in...",
        `  (If it doesn't open, visit: ${loginUrl})\n`,
      ].join("\n"),
    );

    yield* openBrowser(loginUrl);
    yield* Console.log("  Waiting for approval in the browser...");
    return yield* waitForCallback(LOCALHOST_CALLBACK_PORT, state, 10 * 60 * 1000).pipe(
      Effect.catchAll((error) => failCommand(`\n  Login failed: ${errorMessage(error)}\n`)),
    );
  });
}

function saveSession(
  serverUrl: string,
  result: CallbackResult,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    // Store the session, then fetch + record the user identity.
    const sessionAuth: Auth = { token: result.token, type: "session", cfToken: result.cfToken };
    yield* cfg.saveCredentials(serverUrl, sessionAuth);
    const user = yield* getCurrentUser({ serverUrl, auth: sessionAuth }).pipe(
      Effect.map(({ user }) => user as User),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    yield* cfg.saveCredentials(serverUrl, {
      ...sessionAuth,
      user: user ? { id: user.id, email: user.email, name: user.name } : undefined,
    });
    yield* Console.log(`\n  Logged in${user ? ` as ${user.email}` : ""} to ${serverUrl}\n`);
  });
}

export function runLogout({ server: serverFlag = null }: ServerConfig = {}): Effect.Effect<
  void,
  PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const serverUrl = yield* cfg.resolveServerUrl({ flag: serverFlag });
    yield* cfg.clearCredentials(serverUrl);
    yield* Console.log(`Logged out from ${serverUrl}`);
  });
}

export function runWhoami({ server: serverFlag = null }: ServerConfig = {}): Effect.Effect<
  void,
  CliError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const serverUrl = yield* cfg.resolveServerUrl({ flag: serverFlag });
    const auth = yield* cfg.resolveAuth(serverUrl);
    const info = yield* apiWhoami({ serverUrl, auth }).pipe(
      Effect.catchAll((error) => failCommand(`scratchwork whoami: ${errorMessage(error)}`)),
    );
    yield* Console.log(formatWhoami(serverUrl, info));
  });
}

function formatWhoami(serverUrl: string, info: WhoamiResult): string {
  const lines = [`server:        ${serverUrl}`];
  if (info.mode === "accounts" && info.authenticated && info.user) {
    lines.push(`logged in as:  ${info.user.email}${info.user.name ? ` (${info.user.name})` : ""}`);
    if (info.user.slug) lines.push(`slug:          ${info.user.slug}`);
  } else if (info.mode === "accounts") {
    lines.push(`logged in as:  (not logged in — run: scratchwork login --server ${serverUrl})`);
  } else {
    lines.push(`auth required: ${info.authRequired}`);
    lines.push(`authenticated: ${info.authenticated}`);
  }
  return lines.join("\n");
}

function failCommand(message: string): Effect.Effect<never, CliError> {
  return Console.error(message).pipe(
    Effect.zipRight(Effect.fail(new CliError({ code: 1 }))),
  );
}
