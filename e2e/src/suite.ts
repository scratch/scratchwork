/*
 * The full-loop publish suite, run unchanged against every backend lane:
 * real CLI (subprocess) + real server (subprocess) + hermetic OAuth provider
 * (loopback HTTP), through login → publish → serve → republish → share →
 * revoke → access enforcement.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  type BackendLane,
} from "./harness";
import { startOauthProvider, type OauthProvider } from "./oauth-provider";

const CLIENT_ID = "e2e-client-id";
const CLIENT_SECRET = "e2e-client-secret";
const SESSION_SECRET = "e2e-session-secret-e2e-session-secret";

const OWNER = { sub: "owner-1", email: "owner@example.com", name: "Owner" };
const VIEWER = { sub: "viewer-1", email: "viewer@example.net", name: "Viewer" };

/** Everything one lane's tests share. */
export interface LaneContext {
  readonly provider: OauthProvider;
  readonly backend: Backend;
  readonly appUrl: string;
  readonly contentUrl: string;
}

/** Drives a full `scratchwork login` for the current provider user: spawns the
 * CLI, walks the browser leg (app → provider → app callback → loopback), and
 * waits for the CLI to store the token. */
export async function loginCli(
  context: LaneContext,
  home: string,
  cwd: string,
  browser = new Browser(),
): Promise<void> {
  const proc = spawnCli(["login", context.appUrl], cwd, { SCRATCHWORK_HOME: home });
  const output = await readOutputUntil(proc, "cli_redirect=");
  const match = output.match(/https?:\/\/\S+\/auth\/login\?\S+/);
  if (match == null) throw new Error(`no login URL in output:\n${output}`);

  const result = await browser.get(match[0]);
  expect(await result.response.text()).toContain("login complete");
  expect(result.status).toBe(200);

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
}

/** Logs a browser session in on the app host (no CLI involved). */
export async function loginBrowser(context: LaneContext, browser: Browser): Promise<void> {
  await browser.get(`${context.appUrl}/auth/login?returnTo=/`);
  expect(browser.getCookie("localhost", "scratchwork_session")).toBeDefined();
}

/** Registers the full-loop suite for one backend lane. `extraEnv` lets the AWS
 * lane inject its LocalStack endpoint. */
export function publishLoopSuite(
  lane: BackendLane,
  options: {
    readonly setup?: () => Promise<{ readonly extraEnv: Record<string, string>; readonly teardown: () => Promise<void> }>;
  } = {},
): void {
  describe(`publish loop [${lane}]`, () => {
    const project = `e2e-${lane}`;
    let context: LaneContext;
    let laneTeardown: (() => Promise<void>) | undefined;
    let provider: OauthProvider;
    let backend: Backend;
    const ownerHome = tempDir(`scratchwork-e2e-${lane}-home-`);
    const site = tempDir(`scratchwork-e2e-${lane}-site-`);
    const ownerBrowser = new Browser();

    beforeAll(async () => {
      const setup = await options.setup?.();
      laneTeardown = setup?.teardown;
      const port = nextPort();
      const appUrl = `http://localhost:${port}`;
      provider = await startOauthProvider({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: `${appUrl}/auth/callback/google`,
        user: OWNER,
      });
      backend = await startBackend(lane, {
        port,
        providerEnv: provider.env,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        sessionSecret: SESSION_SECRET,
        extraEnv: setup?.extraEnv,
      });
      context = { provider, backend, appUrl: backend.appUrl, contentUrl: backend.contentUrl };

      writeFileSync(join(site.path, "index.html"), "<h1>marker-v1</h1>");
    }, 240_000);

    afterAll(async () => {
      await backend?.stop();
      provider?.stop();
      await laneTeardown?.();
      ownerHome.remove();
      site.remove();
    });

    test("login: the hermetic provider round trip stores a working token", async () => {
      provider.user = OWNER;
      await loginCli(context, ownerHome.path, site.path);

      // The provider saw a spec-shaped authorization request (state, nonce, PKCE).
      const authorize = provider.authorizeRequests.at(-1);
      expect(authorize?.params.code_challenge_method).toBe("S256");
      expect(authorize?.params.nonce).toBeDefined();

      const auth = JSON.parse(readFileSync(join(ownerHome.path, "auth.json"), "utf8"));
      expect(auth.servers[context.appUrl].email).toBe(OWNER.email);

      const me = await runCli(["me", "--server", context.appUrl], site.path, { SCRATCHWORK_HOME: ownerHome.path });
      expect(me.code).toBe(0);
      expect(me.stdout).toContain(OWNER.email);
    }, 60_000);

    test("publish: a private project serves to its owner through the handoff", async () => {
      const published = await runCli(
        ["publish", ".", "--server", context.appUrl, "--project", project],
        site.path,
        { SCRATCHWORK_HOME: ownerHome.path },
      );
      expect(published.stderr).toBe("");
      expect(published.code).toBe(0);
      expect(published.stdout).toContain(project);

      // An anonymous visitor is bounced toward login, never into the content.
      // (Following further would "log in" via the auto-approving hermetic
      // provider, so the browser stops at the login redirect.)
      const anonymous = await new Browser().get(`${context.contentUrl}/${project}/`, {
        stopWhen: (next) => next.includes("/auth/login"),
      });
      expect(anonymous.status).toBe(302);
      expect(anonymous.hops.at(-1)?.location).toContain("/auth/login");

      // The owner's browser session flows through /auth/project → handoff →
      // path-scoped cookie → content.
      provider.user = OWNER;
      await loginBrowser(context, ownerBrowser);
      const page = await ownerBrowser.get(`${context.contentUrl}/${project}/`);
      expect(page.status).toBe(200);
      expect(await page.response.text()).toContain("marker-v1");
      // The redeemed access cookie is scoped to this project's path.
      expect(ownerBrowser.getCookie("pages.localhost", `scratchwork_access_${project}`)).toBeDefined();
    }, 60_000);

    test("republish: .scratchwork.json reuse updates the same project without flags", async () => {
      const saved = JSON.parse(readFileSync(join(site.path, ".scratchwork.json"), "utf8"));
      expect(saved.project).toBe(project);
      expect(saved.server).toBe(context.appUrl);

      writeFileSync(join(site.path, "index.html"), "<h1>marker-v2</h1>");
      const republished = await runCli(["publish", "."], site.path, { SCRATCHWORK_HOME: ownerHome.path });
      expect(republished.stderr).toBe("");
      expect(republished.code).toBe(0);

      const page = await ownerBrowser.get(`${context.contentUrl}/${project}/`);
      expect(page.status).toBe(200);
      expect(await page.response.text()).toContain("marker-v2");
    }, 60_000);

    test("share grants a viewer read access; revoke removes it for live sessions", async () => {
      const shared = await runCli(
        ["share", VIEWER.email, "--server", context.appUrl, "--project", project],
        site.path,
        { SCRATCHWORK_HOME: ownerHome.path },
      );
      expect(shared.stderr).toBe("");
      expect(shared.code).toBe(0);

      provider.user = VIEWER;
      const viewerBrowser = new Browser();
      await loginBrowser(context, viewerBrowser);
      const page = await viewerBrowser.get(`${context.contentUrl}/${project}/`);
      expect(page.status).toBe(200);
      expect(await page.response.text()).toContain("marker-v2");

      const revoked = await runCli(
        ["revoke", VIEWER.email, "--server", context.appUrl, "--project", project],
        site.path,
        { SCRATCHWORK_HOME: ownerHome.path },
      );
      expect(revoked.stderr).toBe("");
      expect(revoked.code).toBe(0);

      // The viewer still holds the path-scoped access cookie from the earlier
      // visit; access is re-checked on every request, so revocation is immediate.
      const denied = await viewerBrowser.get(`${context.contentUrl}/${project}/`);
      expect(denied.status).not.toBe(200);
      const deniedBody = await denied.response.text();
      expect(deniedBody).not.toContain("marker-v2");
    }, 60_000);

    test("a public project serves without any credentials", async () => {
      const publicSite = tempDir(`scratchwork-e2e-${lane}-public-`);
      try {
        writeFileSync(join(publicSite.path, "index.html"), "<h1>public-marker</h1>");
        const published = await runCli(
          ["publish", ".", "--server", context.appUrl, "--project", `${project}-pub`, "--public"],
          publicSite.path,
          { SCRATCHWORK_HOME: ownerHome.path },
        );
        expect(published.stderr).toBe("");
        expect(published.code).toBe(0);

        const page = await rawFetch(`${context.contentUrl}/${project}-pub/`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("public-marker");
      } finally {
        publicSite.remove();
      }
    }, 60_000);
  });
}
