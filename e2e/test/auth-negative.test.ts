/*
 * Auth-negative lanes, driven end to end against the local-dev backend: state
 * tampering, code interception and replay, provider denial and malformed
 * responses, key rotation, cookie/origin isolation across the app and content
 * hosts, and allow-list removal revoking live sessions. Deterministic: the
 * only substituted component is Google (the hermetic provider).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Browser,
  nextPort,
  rawFetch,
  readOutputUntil,
  runCli,
  spawnCli,
  startBackend,
  tempDir,
  type Backend,
} from "../src/harness";
import { loginBrowser, loginCli, type LaneContext } from "../src/suite";
import { startOauthProvider, type OauthProvider } from "../src/oauth-provider";

const CLIENT_ID = "e2e-client-id";
const CLIENT_SECRET = "e2e-client-secret";
const SESSION_SECRET = "e2e-session-secret-e2e-session-secret";
const OWNER = { sub: "owner-1", email: "owner@example.com" };
const VIEWER = { sub: "viewer-1", email: "viewer@example.net" };

/** A valid-format PKCE verifier that matches no issued challenge. */
const WRONG_VERIFIER = "wrong-verifier-wrong-verifier-wrong-verif1";

describe("auth negative lanes [local-dev]", () => {
  let provider: OauthProvider;
  let backend: Backend;
  let context: LaneContext;
  const ownerHome = tempDir("scratchwork-e2e-neg-home-");
  const siteA = tempDir("scratchwork-e2e-neg-a-");
  const siteB = tempDir("scratchwork-e2e-neg-b-");
  const ownerBrowser = new Browser();
  const loginProcesses = new Set<Bun.Subprocess>();

  afterEach(async () => {
    await Promise.all([...loginProcesses].map(async (proc) => {
      if (proc.exitCode == null) proc.kill();
      await proc.exited;
      loginProcesses.delete(proc);
    }));
  });

  beforeAll(async () => {
    const port = nextPort();
    const appUrl = `http://localhost:${port}`;
    provider = await startOauthProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: `${appUrl}/auth/callback/google`,
      user: OWNER,
    });
    backend = await startBackend("local-dev", {
      port,
      providerEnv: provider.env,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      sessionSecret: SESSION_SECRET,
    });
    context = { provider, backend, appUrl: backend.appUrl, contentUrl: backend.contentUrl };
    writeFileSync(join(siteA.path, "index.html"), "<h1>site-a-secret</h1>");
    writeFileSync(join(siteB.path, "index.html"), "<h1>site-b-secret</h1>");
  }, 120_000);

  afterAll(async () => {
    await backend?.stop();
    provider?.stop();
    ownerHome.remove();
    siteA.remove();
    siteB.remove();
  });

  /** Spawns `scratchwork login` and returns its printed login URL. */
  async function startCliLogin(home: string) {
    const proc = spawnCli(["login", context.appUrl], siteA.path, { SCRATCHWORK_HOME: home });
    loginProcesses.add(proc);
    const output = await readOutputUntil(proc, "cli_redirect=");
    const match = output.match(/https?:\/\/\S+\/auth\/login\?\S+/);
    if (match == null) throw new Error(`no login URL in output:\n${output}`);
    return { proc, loginUrl: match[0] };
  }

  test("a denial at the provider is relayed to the CLI, which fails cleanly", async () => {
    provider.authorizeResult = "deny";
    const home = tempDir("scratchwork-e2e-deny-home-");
    try {
      const { proc, loginUrl } = await startCliLogin(home.path);
      const result = await new Browser().get(loginUrl);
      expect(result.status).toBe(400);
      expect(await result.response.text()).toContain("login failed");

      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("access_denied");
    } finally {
      provider.authorizeResult = "success";
      home.remove();
    }
  }, 60_000);

  test("an intercepted CLI code cannot be redeemed without the verifier, and the attempt burns it", async () => {
    const home = tempDir("scratchwork-e2e-intercept-home-");
    try {
      const { proc, loginUrl } = await startCliLogin(home.path);
      // Play the network attacker: observe the loopback redirect without
      // delivering it, stealing the one-time code. (The provider also lives on
      // 127.0.0.1, so stop specifically at the CLI's registered callback.)
      const cliRedirect = new URL(loginUrl).searchParams.get("cli_redirect") as string;
      const browser = new Browser();
      const observed = await browser.get(loginUrl, { stopWhen: (next) => next.startsWith(cliRedirect) });
      const loopbackUrl = observed.hops.at(-1)?.location;
      expect(loopbackUrl).toBeDefined();
      const stolenCode = new URL(loopbackUrl as string).searchParams.get("code");
      expect(stolenCode).not.toBeNull();

      // The attacker holds the code but not the CLI's PKCE verifier: the
      // exchange rejects it — and consumes the code in doing so.
      const redirectUri = `${new URL(loopbackUrl as string).origin}/callback`;
      const attack = await rawFetch(`${context.appUrl}/auth/cli/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: stolenCode, codeVerifier: WRONG_VERIFIER, redirectUri }),
      });
      expect(attack.status).toBe(400);

      // Delivering the callback to the real CLI now fails too: burned code.
      const delivered = await fetch(loopbackUrl as string);
      expect(delivered.status).toBe(400);
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("already redeemed");
    } finally {
      home.remove();
    }
  }, 60_000);

  test("a tampered callback state parameter is rejected before any code exchange", async () => {
    const browser = new Browser();
    const toCallback = await browser.get(`${context.appUrl}/auth/login?returnTo=/`, {
      stopWhen: (next) => next.includes("/auth/callback/"),
    });
    const callbackUrl = new URL(toCallback.hops.at(-1)?.location as string);
    callbackUrl.searchParams.set("state", "tampered-state");
    const tokenRequestsBefore = provider.tokenRequests.length;

    const response = await browser.request(callbackUrl.toString());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid or expired OAuth state");
    // No further round trip to the provider happened.
    expect(provider.tokenRequests.length).toBe(tokenRequestsBefore);
  }, 60_000);

  test("a malformed provider token response fails the login", async () => {
    provider.tokenResponseOverride = () => new Response("<html>not a token</html>", { status: 200 });
    try {
      const result = await new Browser().get(`${context.appUrl}/auth/login?returnTo=/`);
      expect(result.status).toBe(401);
    } finally {
      provider.tokenResponseOverride = null;
    }
  }, 60_000);

  test("an ID token carrying the wrong nonce is rejected", async () => {
    provider.idTokenClaims = { nonce: "evil-nonce" };
    try {
      const result = await new Browser().get(`${context.appUrl}/auth/login?returnTo=/`);
      expect(result.status).toBe(401);
    } finally {
      provider.idTokenClaims = {};
    }
  }, 60_000);

  test("provider key rotation: tokens signed by a fresh key verify via JWKS refetch", async () => {
    await provider.rotateKeys(true);
    const browser = new Browser();
    provider.user = OWNER;
    await loginBrowser(context, browser);
  }, 60_000);

  test("project-access cookies are project-bound: one project's cookie opens nothing else", async () => {
    provider.user = OWNER;
    await loginCli(context, ownerHome.path, siteA.path);
    for (const [site, name] of [[siteA, "neg-a"], [siteB, "neg-b"]] as const) {
      const published = await runCli(
        ["publish", ".", "--server", context.appUrl, "--project", name],
        site.path,
        { SCRATCHWORK_HOME: ownerHome.path },
      );
      expect(published.stderr).toBe("");
      expect(published.code).toBe(0);
    }

    await loginBrowser(context, ownerBrowser);
    const pageA = await ownerBrowser.get(`${context.contentUrl}/neg-a/`);
    expect(pageA.status).toBe(200);
    const cookieA = ownerBrowser.getCookie("pages.localhost", "scratchwork_access_neg-a");
    expect(cookieA).toBeDefined();

    // Present project A's redeemed cookie against project B — under B's cookie
    // name, since names are per-project — with no other credentials.
    const attacker = new Browser();
    attacker.setCookie("pages.localhost", "scratchwork_access_neg-b", cookieA as string, "/neg-b");
    const crossProject = await attacker.request(`${context.contentUrl}/neg-b/`);
    expect(crossProject.status).not.toBe(200);
    expect(await crossProject.text()).not.toContain("site-b-secret");
  }, 90_000);

  test("an app-host session cookie grants nothing on the content host", async () => {
    const session = ownerBrowser.getCookie("localhost", "scratchwork_session");
    expect(session).toBeDefined();

    const attacker = new Browser();
    attacker.setCookie("pages.localhost", "scratchwork_session", session as string, "/");
    attacker.setCookie("pages.localhost", "scratchwork_access_neg-a", session as string, "/neg-a");
    const response = await attacker.request(`${context.contentUrl}/neg-a/`);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("site-a-secret");
  }, 60_000);

  test("handoff tokens replay within their 60-second lifetime — the documented stateless trade-off", async () => {
    // Capture a handoff URL without redeeming it.
    const capture = new Browser();
    provider.user = OWNER;
    await loginBrowser(context, capture);
    const toHandoff = await capture.get(`${context.contentUrl}/neg-a/`, {
      stopWhen: (next) => next.includes("_scratchwork_handoff="),
    });
    const handoffUrl = toHandoff.hops.at(-1)?.location;
    expect(handoffUrl).toBeDefined();

    // Both redemptions succeed: handoff tokens are stateless and short-lived,
    // replayable within their lifetime by accepted design (invariant 3's
    // documented trade-off) — expiry and tampering are covered at the unit
    // level. If this test starts failing because replay is rejected, the
    // trade-off changed: update the invariant notes, not just this test.
    for (let attempt = 0; attempt < 2; attempt++) {
      const redeemed = await rawFetch(handoffUrl as string);
      expect(redeemed.status).toBe(302);
      expect(redeemed.headers.getSetCookie().join(";")).toContain("scratchwork_access_neg-a");
    }
  }, 60_000);

  test("allow-list removal revokes a live CLI session at the next request", async () => {
    const port = nextPort();
    const appUrl = `http://localhost:${port}`;
    const restrictedProvider = await startOauthProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: `${appUrl}/auth/callback/google`,
      user: VIEWER,
    });
    const home = tempDir("scratchwork-e2e-allowlist-home-");
    const laneEnv = {
      port,
      providerEnv: restrictedProvider.env,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      sessionSecret: SESSION_SECRET,
    };
    let stage = await startBackend("local-dev", {
      ...laneEnv,
      extraEnv: { SCRATCHWORK_ALLOWED_USERS: `${OWNER.email},${VIEWER.email}` },
    });
    try {
      const stagedContext: LaneContext = { provider: restrictedProvider, backend: stage, appUrl: stage.appUrl, contentUrl: stage.contentUrl };
      await loginCli(stagedContext, home.path, siteA.path);
      const before = await runCli(["me", "--server", appUrl], siteA.path, { SCRATCHWORK_HOME: home.path });
      expect(before.code).toBe(0);
      expect(before.stdout).toContain(VIEWER.email);

      // The operator removes the viewer and the server restarts with the same
      // session secret: the still-valid signature no longer authenticates.
      await stage.stop();
      stage = await startBackend("local-dev", {
        ...laneEnv,
        extraEnv: { SCRATCHWORK_ALLOWED_USERS: OWNER.email },
      });
      const after = await runCli(["me", "--server", appUrl], siteA.path, { SCRATCHWORK_HOME: home.path });
      expect(after.stdout).not.toContain(VIEWER.email);
      expect(`${after.stdout}${after.stderr}`).toContain("false");
    } finally {
      await stage.stop();
      restrictedProvider.stop();
      home.remove();
    }
  }, 120_000);
});
