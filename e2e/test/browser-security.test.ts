/*
 * The cross-host browser security suite (AGENTS.md, invariant 5), run in a
 * real headless Chromium against the local-dev backend with real app
 * (localhost), content (pages.localhost), and homepage (home.localhost)
 * hostnames. These guarantees exist only in a real browser — host-only cookie
 * scoping, the public-suffix rule for *.localhost, real Origin/Referer/
 * Sec-Fetch-* emission, and what arbitrary published JavaScript can actually
 * do — which is why the fetch-level jar in harness.ts cannot stand in here.
 * Browser rendering fidelity remains a non-goal; only security behavior is
 * asserted.
 *
 * Browser bootstrap: system Chrome when available, else the
 * playwright-managed chromium (auto-installed on first run, like the AWS
 * lane's LocalStack image pull).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser as ChromiumBrowser, type BrowserContext, type Page } from "playwright";
import { nextPort, runCli, startBackend, tempDir, type Backend } from "../src/harness";
import { loginCli, type LaneContext } from "../src/suite";
import { startOauthProvider, type OauthProvider } from "../src/oauth-provider";

const CLIENT_ID = "e2e-client-id";
const CLIENT_SECRET = "e2e-client-secret";
const SESSION_SECRET = "e2e-session-secret-e2e-session-secret";
const OWNER = { sub: "owner-1", email: "owner@example.com" };

const SESSION_COOKIE = "scratchwork_session";

/** Launches a headless browser: system Chrome first, then playwright's
 * chromium, installing it on demand. */
async function launchChromium(): Promise<ChromiumBrowser> {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    // fall through to the managed browser
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    const install = Bun.spawnSync(["bun", "x", "playwright", "install", "chromium"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!install.success) {
      throw new Error("no Chrome available and `playwright install chromium` failed — install Google Chrome or run `bun x playwright install chromium`");
    }
    return chromium.launch({ headless: true });
  }
}

describe("browser security [local-dev]", () => {
  let provider: OauthProvider;
  let backend: Backend;
  let context: LaneContext;
  let chrome: ChromiumBrowser;
  let appUrl: string;
  let contentUrl: string;
  let homeUrl: string;
  const ownerHome = tempDir("scratchwork-browser-home-");
  const privateSite = tempDir("scratchwork-browser-private-");
  const attackerSite = tempDir("scratchwork-browser-attacker-");
  const homeSite = tempDir("scratchwork-browser-homepage-");
  const commentsSite = tempDir("scratchwork-browser-comments-");

  beforeAll(async () => {
    const port = nextPort();
    appUrl = `http://localhost:${port}`;
    contentUrl = `http://pages.localhost:${port}`;
    homeUrl = `http://home.localhost:${port}`;
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
      extraEnv: {
        SCRATCHWORK_HOMEPAGE_DOMAINS: homeUrl,
        SCRATCHWORK_HOMEPAGE_PROJECT: "sec-home",
      },
    });
    context = { provider, backend, appUrl: backend.appUrl, contentUrl: backend.contentUrl };

    writeFileSync(join(privateSite.path, "index.html"), "<h1>private-secret</h1>");
    writeFileSync(join(privateSite.path, "data.txt"), "secret-data");
    writeFileSync(join(attackerSite.path, "index.html"), "<h1>attacker-page</h1>");
    writeFileSync(join(homeSite.path, "index.html"), "<h1>home-secret</h1>");
    writeFileSync(join(commentsSite.path, "index.html"), "<html><body><h1 id=\"headline\">comments-page</h1></body></html>");

    await loginCli(context, ownerHome.path, privateSite.path);
    for (const [dir, name, ...flags] of [
      [privateSite.path, "sec-private", "--private"],
      [attackerSite.path, "sec-attacker", "--public"],
      [homeSite.path, "sec-home", "--private"],
      [commentsSite.path, "sec-comments", "--private", "--comments"],
    ] as const) {
      const published = await runCli(
        ["publish", ".", "--server", appUrl, "--project", name, ...flags],
        dir,
        { SCRATCHWORK_HOME: ownerHome.path },
      );
      expect(published.stderr).toBe("");
      expect(published.code).toBe(0);
    }

    chrome = await launchChromium();
  }, 240_000);

  afterAll(async () => {
    await chrome?.close();
    await backend?.stop();
    provider?.stop();
    ownerHome.remove();
    privateSite.remove();
    attackerSite.remove();
    homeSite.remove();
    commentsSite.remove();
  });

  /** Completes the browser login redirect dance through the hermetic provider. */
  async function loginChrome(page: Page): Promise<void> {
    await page.goto(`${appUrl}/auth/login?returnTo=/`, { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).origin).toBe(appUrl);
  }

  /** A fresh signed-in browser profile. */
  async function signedInContext(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await chrome.newContext();
    const page = await ctx.newPage();
    await loginChrome(page);
    return { ctx, page };
  }

  test("the session cookie is host-only on the app origin, HttpOnly, and SameSite=Lax", async () => {
    const { ctx, page } = await signedInContext();
    try {
      const cookies = await ctx.cookies(appUrl);
      const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
      expect(session).toBeDefined();
      expect(session?.domain).toBe("localhost"); // host-only: no leading dot
      expect(session?.path).toBe("/");
      expect(session?.httpOnly).toBe(true);
      expect(session?.sameSite).toBe("Lax");

      // The content host never receives it on the wire (Playwright's cookie
      // listing suffix-matches domains, so inspect a real request instead),
      // and page JavaScript cannot read it on its own origin.
      const contentRequest = page.waitForRequest(`${contentUrl}/sec-attacker/`);
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      const sentCookies = (await (await contentRequest).allHeaders())["cookie"] ?? "";
      expect(sentCookies).not.toContain(SESSION_COOKIE);
      await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("private content is served through a handoff cookie scoped to its own path", async () => {
    const { ctx, page } = await signedInContext();
    try {
      await page.goto(`${contentUrl}/sec-private/`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toBe(`${contentUrl}/sec-private/`);
      expect(await page.textContent("h1")).toBe("private-secret");

      const cookies = await ctx.cookies(`${contentUrl}/sec-private/`);
      const access = cookies.find((cookie) => cookie.name === "scratchwork_access_sec-private");
      expect(access).toBeDefined();
      expect(access?.domain).toBe("pages.localhost");
      expect(access?.path).toBe("/sec-private");
      expect(access?.httpOnly).toBe(true);
      // Outside its path the browser does not send it.
      const rootCookies = await ctx.cookies(`${contentUrl}/`);
      expect(rootCookies.find((cookie) => cookie.name === "scratchwork_access_sec-private")).toBeUndefined();
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("published JavaScript cannot plant or override an app session", async () => {
    const { ctx, page } = await signedInContext();
    try {
      const before = (await ctx.cookies(appUrl)).find((cookie) => cookie.name === SESSION_COOKIE);
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        // Host-only plant on the content host, and two parent-domain attempts:
        // *.localhost sits on the public suffix list, so browsers refuse the
        // Domain= variants outright.
        document.cookie = "scratchwork_session=evil; path=/";
        document.cookie = "scratchwork_session=evil; domain=localhost; path=/";
        document.cookie = "scratchwork_session=evil; domain=.localhost; path=/";
      });

      const after = (await ctx.cookies(appUrl)).find((cookie) => cookie.name === SESSION_COOKIE);
      expect(after?.value).toBe(before!.value);
      expect(after?.domain).toBe("localhost");

      // The app still authenticates the real owner.
      await page.goto(`${appUrl}/api/me`, { waitUntil: "domcontentloaded" });
      const me = JSON.parse((await page.textContent("body")) ?? "{}") as { user?: { email?: string } };
      expect(me.user?.email).toBe(OWNER.email);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("a forged access cookie planted by published JavaScript grants nothing", async () => {
    const ctx = await chrome.newContext(); // anonymous profile
    const page = await ctx.newPage();
    provider.authorizeResult = "deny"; // the redirect chain must dead-end at auth, not auto-login
    try {
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        // Same-host, so the browser accepts it — the server must not.
        document.cookie = "scratchwork_access_sec-private=forged.payload; path=/sec-private";
      });
      const response = await page.goto(`${contentUrl}/sec-private/`, { waitUntil: "domcontentloaded" });
      expect(await page.content()).not.toContain("private-secret");
      expect(response?.ok()).toBe(false);
    } finally {
      provider.authorizeResult = "success";
      await ctx.close();
    }
  }, 60_000);

  test("another project's page cannot load private content as a subresource", async () => {
    const { ctx, page } = await signedInContext();
    try {
      // Establish the viewer's legitimate access cookie first.
      await page.goto(`${contentUrl}/sec-private/`, { waitUntil: "domcontentloaded" });
      expect(await page.textContent("h1")).toBe("private-secret");

      // Same-origin fetch from another project: the cookie is in scope for
      // the path, but the Referer proves the requesting page is foreign.
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      const fetchStatus = await page.evaluate(async () => (await fetch("/sec-private/data.txt")).status);
      expect(fetchStatus).toBe(403);
      const imgLoaded = await page.evaluate(() =>
        new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = "/sec-private/data.txt";
        }),
      );
      expect(imgLoaded).toBe(false);

      // Top-level navigation stays unrestricted for the authorized viewer.
      const direct = await page.goto(`${contentUrl}/sec-private/data.txt`, { waitUntil: "domcontentloaded" });
      expect(direct?.status()).toBe(200);
      expect(await direct?.text()).toBe("secret-data");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("cross-origin API mutations are rejected by origin policy before anything else", async () => {
    const { ctx, page } = await signedInContext();
    try {
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      // A top-level form POST carries a real cross-origin Origin header and no
      // CORS preflight — the server itself must reject it (403 origin policy,
      // not 401 missing bearer, proving the origin gate runs first).
      const [response] = await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.evaluate((target) => {
          const form = document.createElement("form");
          form.method = "POST";
          form.action = `${target}/api/projects/sec-private/share`;
          document.body.append(form);
          form.submit();
        }, appUrl),
      ]);
      expect(response?.status()).toBe(403);
      expect(await page.content()).toContain("Cross-origin");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("the comments widget runs for viewers in-project; foreign pages cannot reach the comments API", async () => {
    const { ctx, page } = await signedInContext();
    try {
      // The injected widget boots inside the real page and renders its UI in
      // a shadow root once the same-origin list fetch (cookie-authenticated)
      // succeeds.
      await page.goto(`${contentUrl}/sec-comments/`, { waitUntil: "domcontentloaded" });
      expect(await page.textContent("#headline")).toBe("comments-page");
      await page.waitForFunction(() => {
        const host = document.querySelector("[data-scratchwork-comments]");
        return host?.shadowRoot?.querySelector(".fab") != null;
      });

      // Creating a comment exactly as the widget does works from in-project JS.
      const created = await page.evaluate(async () => {
        const response = await fetch("/sec-comments/__scratchwork/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page: "/", body: "from a real browser", anchors: [{ selector: "#headline", x: 5, y: 5 }, { selector: "body", x: 5, y: 5 }] }),
        });
        return response.status;
      });
      expect(created).toBe(200);

      // A reload shows the persisted comment as a pin.
      await page.goto(`${contentUrl}/sec-comments/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const host = document.querySelector("[data-scratchwork-comments]");
        return host?.shadowRoot?.querySelector(".pin") != null;
      });

      // Another project's page on the same origin: the Referer proves the
      // requesting page is foreign, so the request dies at the cross-project
      // guard (and the path-scoped cookie wouldn't attach anyway).
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      const attackerRead = await page.evaluate(async () =>
        (await fetch("/sec-comments/__scratchwork/comments?page=/")).status);
      expect(attackerRead).toBe(403);
      // The public attacker page gets no widget injected.
      expect(await page.evaluate(() => document.querySelector("[data-scratchwork-comments]") == null)).toBe(true);

      // A cross-origin top-level form POST (real Origin header, no preflight)
      // from the app origin to the content-host comments API is rejected by
      // the origin gate before auth even runs (403, not a 401 cookie demand).
      await page.goto(`${appUrl}/`, { waitUntil: "domcontentloaded" });
      const [response] = await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.evaluate((target) => {
          const form = document.createElement("form");
          form.method = "POST";
          form.action = `${target}/sec-comments/__scratchwork/comments`;
          document.body.append(form);
          form.submit();
        }, contentUrl),
      ]);
      expect(response?.status()).toBe(403);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("auth redirects never leave their intended origins", async () => {
    const { ctx, page } = await signedInContext();
    try {
      await page.goto(`${appUrl}/auth/login?returnTo=https://evil.example/`, { waitUntil: "domcontentloaded" });
      expect(new URL(page.url()).origin).toBe(appUrl);

      await page.goto(`${appUrl}/auth/project?route=sec-private&returnTo=https://evil.example/`, { waitUntil: "domcontentloaded" });
      expect(page.url().startsWith(`${contentUrl}/sec-private`)).toBe(true);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  test("the private homepage origin is isolated from content-host pages", async () => {
    const { ctx, page } = await signedInContext();
    try {
      // The owner reads the homepage through the handoff; the cookie is scoped
      // to the home origin's root.
      await page.goto(`${homeUrl}/`, { waitUntil: "domcontentloaded" });
      expect(await page.textContent("h1")).toBe("home-secret");
      const cookies = await ctx.cookies(homeUrl);
      const access = cookies.find((cookie) => cookie.name === "scratchwork_access_sec-home");
      expect(access?.domain).toBe("home.localhost");

      // A content-host page cannot pull the private homepage in as a
      // subresource: its request carries no home-origin referer page.
      await page.goto(`${contentUrl}/sec-attacker/`, { waitUntil: "domcontentloaded" });
      const observed = page.waitForResponse((candidate) => candidate.url().startsWith(homeUrl));
      await page.evaluate(
        (target) => fetch(target, { mode: "no-cors", credentials: "include" }).catch(() => null),
        `${homeUrl}/`,
      );
      const response = await observed;
      expect([401, 403]).toContain(response.status());
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
