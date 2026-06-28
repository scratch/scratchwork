import {
  whoami as apiWhoami,
  getCurrentUser,
} from "../lib/server-client.js";
import { waitForCallback, generateCallbackState, generateCliCode, LOCALHOST_CALLBACK_PORT } from "../lib/auth-callback.js";
import * as cfg from "../lib/config.js";
import { openBrowser } from "../browser";
import { errorMessage, exit } from "../errors";
import type { Auth, AuthType, CallbackResult, LoginConfig, ServerConfig, User, WhoamiResult } from "../types";

// Read a single line from stdin (used to collect a token interactively).
async function promptLine(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line;
  return "";
}

// `scratchwork login [--server URL] [--token TOKEN]`
//
// On an accounts-mode server: opens the browser, you approve, and a per-user
// session token is stored. On a legacy single-token server (or with --token):
// stores the pasted token. Open servers need no login.
export async function runLogin({ server: serverFlag = null, token: tokenFlag = null }: LoginConfig = {}): Promise<void> {
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag });

  let info: WhoamiResult;
  try {
    info = await apiWhoami({ serverUrl, auth: null }) as WhoamiResult;
  } catch (err) {
    console.error(`scratchwork login: ${errorMessage(err)}`);
    exit(1);
  }
  if (!info.authRequired) {
    console.log(`\n  ${serverUrl} is open — no login needed.\n`);
    return;
  }

  // Explicit token paste (escape hatch / legacy / CI).
  const pasted = tokenFlag || process.env.SCRATCHWORK_TOKEN;
  if (pasted || info.mode !== "accounts") {
    const token = (pasted || (await promptLine(`Paste your token for ${serverUrl}: `))).trim();
    if (!token) {
      console.error("scratchwork login: no token provided");
      exit(1);
    }
    const type: AuthType = token.startsWith("scratchwork_") ? "api_key" : info.mode === "accounts" ? "session" : "bearer";
    const verify = await apiWhoami({ serverUrl, auth: { token, type } }) as WhoamiResult;
    if (!verify.authenticated) {
      console.error("scratchwork login: that token was not accepted by the server");
      exit(1);
    }
    cfg.saveCredentials(serverUrl, { token, type });
    console.log(`\n  Logged in to ${serverUrl}\n`);
    return;
  }

  // Browser login (accounts mode). Show a verification code, open the browser,
  // and wait for the server to hand the session token back to localhost.
  const state = generateCallbackState();
  const code = generateCliCode();
  const loginUrl = `${serverUrl.replace(/\/+$/, "")}/cli-login?state=${state}&code=${code}`;
  console.log(`\n  Your verification code:  ${code}`);
  console.log(`\n  Opening the browser to log in...`);
  console.log(`  (If it doesn't open, visit: ${loginUrl})\n`);

  const callbackPromise = waitForCallback(LOCALHOST_CALLBACK_PORT, state, 10 * 60 * 1000);
  openBrowser(loginUrl);
  console.log("  Waiting for approval in the browser...");

  let result: CallbackResult;
  try {
    result = (await callbackPromise) as CallbackResult;
  } catch (err) {
    console.error(`\n  Login failed: ${errorMessage(err)}\n`);
    exit(1);
  }

  // Store the session, then fetch + record the user identity.
  const sessionAuth: Auth = { token: result.token, type: "session", cfToken: result.cfToken };
  cfg.saveCredentials(serverUrl, sessionAuth);
  let user: User | null = null;
  try {
    ({ user } = await getCurrentUser({ serverUrl, auth: sessionAuth }) as { user: User });
  } catch {
    /* identity is best-effort; the token still works */
  }
  cfg.saveCredentials(serverUrl, {
    ...sessionAuth,
    user: user ? { id: user.id, email: user.email, name: user.name } : undefined,
  });
  console.log(`\n  Logged in${user ? ` as ${user.email}` : ""} to ${serverUrl}\n`);
}

export async function runLogout({ server: serverFlag = null }: ServerConfig = {}): Promise<void> {
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag });
  cfg.clearCredentials(serverUrl);
  console.log(`Logged out from ${serverUrl}`);
}

export async function runWhoami({ server: serverFlag = null }: ServerConfig = {}): Promise<void> {
  const serverUrl = cfg.resolveServerUrl({ flag: serverFlag });
  const auth = cfg.resolveAuth(serverUrl) as Auth | null;
  let info: WhoamiResult;
  try {
    info = await apiWhoami({ serverUrl, auth }) as WhoamiResult;
  } catch (err) {
    console.error(`scratchwork whoami: ${errorMessage(err)}`);
    exit(1);
  }
  console.log(`server:        ${serverUrl}`);
  if (info.mode === "accounts" && info.authenticated && info.user) {
    console.log(`logged in as:  ${info.user.email}${info.user.name ? ` (${info.user.name})` : ""}`);
    if (info.user.slug) console.log(`slug:          ${info.user.slug}`);
  } else if (info.mode === "accounts") {
    console.log(`logged in as:  (not logged in — run: scratchwork login --server ${serverUrl})`);
  } else {
    console.log(`auth required: ${info.authRequired}`);
    console.log(`authenticated: ${info.authenticated}`);
  }
}
