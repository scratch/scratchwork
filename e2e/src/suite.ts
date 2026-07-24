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
  try {
    const output = await readOutputUntil(proc, "cli_redirect=");
    const match = output.match(/https?:\/\/\S+\/auth\/login\?\S+/);
    if (match == null) throw new Error(`no login URL in output:\n${output}`);

    const result = await browser.get(match[0]);
    expect(await result.response.text()).toContain("login complete");
    expect(result.status).toBe(200);

    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    if (proc.exitCode == null) proc.kill();
    await proc.exited;
  }
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
      expect(authorize?.params.scope?.split(/\s+/)).toEqual(expect.arrayContaining(["openid", "email", "profile"]));

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

    // -----------------------------------------------------------------------
    // MCP: the remote endpoint, driven exactly as a spec MCP client would —
    // discovery from the 401 challenge, dynamic registration, the browser
    // authorize + consent leg, the token exchange, then stateless JSON-RPC
    // tool calls. Runs on every lane because statelessness across serverless
    // instances is precisely the claim under test.
    // -----------------------------------------------------------------------

    let ownerMcpToken = "";

    test("mcp: discovery, registration, and the OAuth loop mint a working access token", async () => {
      // 1. An unauthenticated /mcp call carries the resource-metadata pointer.
      const challenge = await rawFetch(`${context.appUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
      });
      expect(challenge.status).toBe(401);
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
      expect(metadataUrl).toBeDefined();

      // 2. Protected-resource metadata → authorization-server metadata.
      const resourceMeta = await (await rawFetch(metadataUrl!)).json() as {
        resource: string; authorization_servers: string[];
      };
      expect(resourceMeta.resource).toBe(`${context.appUrl}/mcp`);
      const asMeta = await (await rawFetch(
        `${resourceMeta.authorization_servers[0]}/.well-known/oauth-authorization-server`,
      )).json() as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };

      // 3. Dynamic client registration.
      const redirectUri = "http://127.0.0.1:39877/callback";
      const registerResponse = await rawFetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          client_name: "e2e MCP client",
          token_endpoint_auth_method: "none",
        }),
      });
      expect(registerResponse.status).toBe(201);
      const registration = await registerResponse.json() as { client_id: string };

      // 4. Authorize: a browser session (auto-approving hermetic provider)
      // lands on the consent page; approval redirects to the loopback with a
      // one-time code.
      const verifier = "e2e-mcp-verifier-e2e-mcp-verifier-e2e-mcp-v1";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challengeS256 = Buffer.from(digest).toString("base64url");
      provider.user = OWNER;
      const mcpBrowser = new Browser();
      const authorizeUrl = new URL(asMeta.authorization_endpoint);
      authorizeUrl.searchParams.set("client_id", registration.client_id);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challengeS256);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", "e2e-mcp-state");
      authorizeUrl.searchParams.set("resource", `${context.appUrl}/mcp`);
      const consentPage = await mcpBrowser.get(authorizeUrl.toString());
      expect(consentPage.status).toBe(200);
      const txn = /name="txn" value="([^"]+)"/.exec(await consentPage.response.text())?.[1];
      expect(txn).toBeDefined();

      const approved = await mcpBrowser.request(`${context.appUrl}/oauth/consent`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ txn: txn!, decision: "approve" }).toString(),
      });
      expect(approved.status).toBe(302);
      const callback = new URL(approved.headers.get("location") ?? "");
      expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
      expect(callback.searchParams.get("state")).toBe("e2e-mcp-state");
      const code = callback.searchParams.get("code");
      expect(code).toBeDefined();

      // 5. Token exchange, then a refresh-grant round trip.
      const tokenResponse = await rawFetch(asMeta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
          resource: `${context.appUrl}/mcp`,
        }).toString(),
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; token_type: string };
      expect(tokens.token_type).toBe("Bearer");

      const refreshed = await rawFetch(asMeta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: registration.client_id,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      ownerMcpToken = ((await refreshed.json()) as { access_token: string }).access_token;
    }, 120_000);

    /** One stateless JSON-RPC call to /mcp. */
    const mcpCall = async (token: string, body: unknown): Promise<{ response: Response; body: any }> => {
      const response = await rawFetch(`${context.appUrl}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { response, body: response.status === 202 ? null : await response.json() };
    };

    test("mcp: stateless tool calls publish and serve content on this lane", async () => {
      expect(ownerMcpToken).not.toBe("");

      // initialize never issues a session id — every later POST stands alone.
      const initialized = await mcpCall(ownerMcpToken, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
      });
      expect(initialized.response.headers.get("mcp-session-id")).toBeNull();
      expect(initialized.body.result.protocolVersion).toBe("2025-06-18");
      const note = await mcpCall(ownerMcpToken, { jsonrpc: "2.0", method: "notifications/initialized" });
      expect(note.response.status).toBe(202);

      const listing = await mcpCall(ownerMcpToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const toolNames = (listing.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(toolNames).toContain("publish");
      expect(toolNames).toContain("share_project");

      // Publish text + binary through the tool; verify the served bytes.
      const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x89, 0x50]);
      const published = await mcpCall(ownerMcpToken, {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: {
          name: "publish",
          arguments: {
            project: `${project}-mcp`,
            isPublic: true,
            files: [
              { path: "index.html", content: "<h1>mcp-marker</h1>" },
              { path: "assets/blob.bin", contentBase64: binary.toString("base64") },
            ],
          },
        },
      });
      expect(published.body.result.isError).toBeUndefined();
      expect(published.body.result.structuredContent.project).toBe(`${project}-mcp`);

      const page = await rawFetch(`${context.contentUrl}/${project}-mcp/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("mcp-marker");
      const blob = await rawFetch(`${context.contentUrl}/${project}-mcp/assets/blob.bin`);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(binary));

      // Share + unpublish smoke through the tools.
      const shared = await mcpCall(ownerMcpToken, {
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "share_project", arguments: { project: `${project}-mcp`, role: "read", add: [VIEWER.email] } },
      });
      expect(shared.body.result.isError).toBeUndefined();
      const unpublished = await mcpCall(ownerMcpToken, {
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "unpublish_project", arguments: { project: `${project}-mcp` } },
      });
      expect(unpublished.body.result.structuredContent.project.isPublic).toBe(false);

      const who = await mcpCall(ownerMcpToken, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "whoami", arguments: {} } });
      expect(who.body.result.structuredContent.user.email).toBe(OWNER.email);
    }, 120_000);
  });
}
