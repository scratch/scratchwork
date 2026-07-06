import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createSessionToken } from "../src/auth";
import { MemoryPrimitiveDbLive } from "../src/db";
import { appHandler, bundle, json, testAuth, type MemoryStoredObject } from "./helpers";

const user = { id: "user-1", email: "founder@example.com" };

const TAKEN = (name: string) =>
  `Project name "${name}" is already taken on this server. Choose another with --project.`;

describe("server app", () => {
  test("publishes files into per-file storage and serves the site", async () => {
    const storage = new Map<string, MemoryStoredObject>();
    const handler = await appHandler({ storage, auth: testAuth(user) });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "<h1>Hello</h1>",
        "style.css": "body { color: red; }",
      }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));

    expect(publish.status).toBe(200);
    const body = await json(publish) as { project: string; url: string };
    expect(body.project).toBe("site");
    expect(body.url).toBe("https://scratch.test/site/");
    expect([...storage.keys()].some((key) => key.startsWith("blobs/sha256/"))).toBe(true);
    const revisionKey = [...storage.keys()].find((key) => key.startsWith("projects/site/revisions/"));
    expect(typeof revisionKey).toBe("string");
    expect(new TextDecoder().decode(storage.get(revisionKey ?? "")?.body)).not.toContain("contentBase64");

    const html = await handler(new Request("https://scratch.test/site/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBeNull();
    expect(html.headers.get("referrer-policy")).toBe("same-origin");
    expect(await html.text()).toContain("Hello");

    const css = await handler(new Request("https://scratch.test/site/style.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("body { color: red; }");

    // An encoded slash cannot fabricate a path inside a project.
    const encodedSlash = await handler(new Request("https://scratch.test/si%2Fte", { redirect: "manual" }));
    expect(encodedSlash.status).toBe(404);

    // A percent-encoded project segment decodes to the same project.
    const encodedSegment = await handler(new Request("https://scratch.test/si%74e/style.css"));
    expect(encodedSegment.status).toBe(200);
    expect(encodedSegment.headers.get("content-type")).toContain("text/css");
  });

  test("republishes by flipping the current revision", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const first = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "old", "old.css": "old" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(first.status).toBe(200);

    const second = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "new" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(second.status).toBe(200);

    const html = await handler(new Request("https://scratch.test/site/"));
    expect(await html.text()).toContain("new");
    const removed = await handler(new Request("https://scratch.test/site/old.css"));
    expect(removed.status).toBe(404);
  });

  test("serves rendered markdown unsandboxed with public asset CORS", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.md": "# Hello", "evil.svg": "<svg><script>alert(1)</script></svg>" }),
      openPath: "/",
      project: "docs",
      visibility: "public",
    }))) as { project: string };

    const html = await handler(new Request(`https://scratch.test/${published.project}/`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBeNull();
    expect(html.headers.get("access-control-allow-origin")).toBe("*");

    const markdown = await handler(new Request(`https://scratch.test/${published.project}/index.md`));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("access-control-allow-origin")).toBe("*");

    const svg = await handler(new Request(`https://scratch.test/${published.project}/evil.svg`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy")).toBeNull();
  });

  test("republishing without visibility preserves the project's visibility", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { defaultVisibility: "private" } });
    const first = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v1" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(first.status).toBe(200);

    const second = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v2" }),
      openPath: "/",
      project: "site",
    }));
    expect(second.status).toBe(200);
    expect(((await json(second)) as { visibility: string }).visibility).toBe("public");

    const html = await handler(new Request("https://scratch.test/site/"));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("v2");
  });

  test("rejects reserved project names", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    for (const project of ["api", "auth", "health", "gh", "google", "robots.txt"]) {
      const response = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": "hello" }),
        openPath: "/",
        project,
        visibility: "public",
      }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`Project name is reserved: ${project}`);
    }
  });

  test("requires a project name when users set project names", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      visibility: "public",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("project name is required (pass --project)");
  });

  test("rejects uppercase project names", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "Docs",
      visibility: "public",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid project");
  });

  test("rejects old clients that still send a workspace field", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("workspace");
  });

  test("returns 409 when another user's project name is taken", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const ownerHandler = await appHandler({ db, storage, auth: testAuth(user) });
    const otherHandler = await appHandler({
      db,
      storage,
      auth: testAuth({ id: "user-2", email: "other@example.com" }),
    });

    const first = await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "mine" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(first.status).toBe(200);

    const taken = await otherHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "theirs" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(taken.status).toBe(409);
    expect((await json(taken) as { error: string }).error).toBe(TAKEN("site"));

    // The owner can still republish.
    const republish = await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "mine v2" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(republish.status).toBe(200);
  });

  test("resolves published content paths to their project", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }))) as { project: string };
    expect(published.project).toBe("site");

    const resolved = await handler(new Request(`https://scratch.test/api/resolve?path=${encodeURIComponent("/site/index.html")}`));
    expect(resolved.status).toBe(200);
    const body = await json(resolved) as { project: { project: string; url: string } };
    expect(body.project.project).toBe("site");
    expect(body.project.url).toBe("https://scratch.test/site/");

    const missing = await handler(new Request("https://scratch.test/api/resolve?path=/no-such-project/"));
    expect(missing.status).toBe(404);

    const unauthenticated = await appHandler({ auth: testAuth(user, null), storage: undefined });
    const denied = await unauthenticated(new Request("https://scratch.test/api/resolve?path=/site/"));
    expect(denied.status).toBe(401);
  });

  test("assigns a random project name when users cannot set project names", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { usersCanSetProjectNames: false } });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      visibility: "public",
    }))) as { project: string; url: string };

    expect(published.project).toMatch(/^[a-z2-9]{10}$/);
    expect(published.url).toBe(`https://scratch.test/${published.project}/`);
  });

  test("random-name republish by returned slug updates the same project", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const handler = await appHandler({ db, storage, auth: testAuth(user), config: { usersCanSetProjectNames: false } });

    const first = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v1" }),
      openPath: "/",
      visibility: "public",
    }))) as { project: string };

    const second = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v2" }),
      openPath: "/",
      project: first.project,
      visibility: "public",
    }))) as { project: string };
    expect(second.project).toBe(first.project);

    const html = await handler(new Request(`https://scratch.test/${first.project}/`));
    expect(await html.text()).toContain("v2");
  });

  test("random mode mints a fresh slug for an unknown sent name", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { usersCanSetProjectNames: false } });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "my-notes",
      visibility: "public",
    }))) as { project: string };

    expect(published.project).toMatch(/^[a-z2-9]{10}$/);
    expect(published.project).not.toBe("my-notes");
  });

  test("random mode returns 409 for a sent name owned by someone else", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const config = { usersCanSetProjectNames: false } as const;
    const ownerHandler = await appHandler({ db, storage, auth: testAuth(user), config });
    const otherHandler = await appHandler({
      db,
      storage,
      auth: testAuth({ id: "user-2", email: "other@example.com" }),
      config,
    });

    const first = await json(await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "mine" }),
      openPath: "/",
      visibility: "public",
    }))) as { project: string };

    const taken = await otherHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "theirs" }),
      openPath: "/",
      project: first.project,
      visibility: "public",
    }));
    expect(taken.status).toBe(409);
    expect((await json(taken) as { error: string }).error).toBe(TAKEN(first.project));
  });

  test("lists projects beyond a single database page with content URLs", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    for (let index = 0; index < 120; index += 1) {
      const published = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": "hello" }),
        openPath: "/",
        project: `site-${String(index).padStart(3, "0")}`,
        visibility: "public",
      }));
      expect(published.status).toBe(200);
    }

    const response = await handler(new Request("https://scratch.test/api/projects"));
    expect(response.status).toBe(200);
    const body = await json(response) as { projects: ReadonlyArray<{ project: string; url: string }> };
    expect(body.projects).toHaveLength(120);
    expect(body.projects[0]?.url).toBe(`https://scratch.test/${body.projects[0]?.project}/`);
  });

  test("requires bearer auth for publish when auth is enabled", async () => {
    const handler = await appHandler({ auth: testAuth(user, null) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
    }));

    expect(response.status).toBe(401);
  });

  test("rejects visibility above the server ceiling", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { maxVisibility: "@example.com" } });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));

    expect(response.status).toBe(403);
  });

  test("rejects public visibility when shareAllowedDomains is set", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { shareAllowedDomains: new Set(["example.com"]) } });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));

    expect(response.status).toBe(403);
  });

  test("rejects garbage project identifiers with client errors, never 500", async () => {
    const handler = await appHandler({ auth: testAuth(user) });

    for (const route of ["", "..", "%2E%2E", ".hidden", "_internal"]) {
      const response = await handler(new Request(`https://scratch.test/auth/project?route=${route}`, { redirect: "manual" }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }

    const apiDelete = await handler(new Request("https://scratch.test/api/projects/%2E%2E", { method: "DELETE" }));
    expect(apiDelete.status).toBe(404);
  });

  test("redirects private content readers through app-domain project auth", async () => {
    const handler = await appHandler({
      auth: testAuth(null, user),
      config: {
        appUrl: "https://app.scratch.test",
        contentUrl: "https://pages.scratch.test",
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private" }),
      openPath: "/",
      project: "secret",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const response = await handler(new Request("https://pages.scratch.test/secret/", { redirect: "manual" }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("https://app.scratch.test");
    expect(location.pathname).toBe("/auth/project");
    expect(location.searchParams.get("route")).toBe("secret");
  });

  test("redirects auth routes to the configured app origin before setting cookies", async () => {
    const handler = await appHandler({
      config: {
        appUrl: "https://app.scratch.test",
        auth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          sessionSecret: "session-secret-session-secret-32-bytes",
          allowedUsers: "public",
          sessionTtlSeconds: 60,
        },
      },
    });

    const response = await handler(new Request(
      "http://scratchwork.local/auth/login?cli_redirect=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback",
      {
        headers: {
          host: "www.scratch.test",
          "x-forwarded-host": "www.scratch.test",
          "x-forwarded-proto": "https",
        },
        redirect: "manual",
      },
    ));

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("https://app.scratch.test");
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("cli_redirect")).toBe("http://127.0.0.1:7777/callback");
  });

  test("uses configured content origin in private asset auth redirects", async () => {
    const handler = await appHandler({
      auth: testAuth(null, user),
      config: {
        appUrl: "https://app.scratch.test",
        contentUrl: "https://pages.scratch.test",
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "private",
        "hello-world.svg": "<svg></svg>",
      }),
      openPath: "/",
      project: "secret",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const response = await handler(new Request("http://scratchwork.local/secret/hello-world.svg", {
      headers: {
        host: "pages.scratch.test",
        "x-forwarded-host": "pages.scratch.test",
        "x-forwarded-proto": "https",
      },
      redirect: "manual",
    }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("https://app.scratch.test");
    expect(location.searchParams.get("route")).toBe("secret");
    expect(location.searchParams.get("returnTo")).toBe("https://pages.scratch.test/secret/hello-world.svg");
  });

  test("authenticates private content through a handoff token and path-scoped cookie", async () => {
    const authConfig = {
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret-session-secret-32-bytes",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    } as const;
    const token = await Effect.runPromise(createSessionToken(user, authConfig));
    const handler = await appHandler({
      config: {
        appUrl: "https://app.scratch.test",
        contentUrl: "https://pages.scratch.test",
        auth: authConfig,
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private page body", "data.json": "{\"secret\":true}" }),
      openPath: "/",
      project: "secret",
      visibility: "private",
    }, token));
    expect(publish.status).toBe(200);

    // The app host authenticates the viewer and redirects back with a one-time handoff
    // token in the query string; the app response itself sets no content cookie.
    const appRedirect = await handler(new Request(
      "https://app.scratch.test/auth/project?route=secret&returnTo=https%3A%2F%2Fpages.scratch.test%2Fsecret%2F",
      { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    ));
    expect(appRedirect.status).toBe(302);
    const handoffUrl = new URL(appRedirect.headers.get("location") ?? "https://invalid");
    expect(handoffUrl.origin).toBe("https://pages.scratch.test");
    expect(handoffUrl.pathname).toBe("/secret/");
    expect(handoffUrl.searchParams.get("_scratchwork_handoff")).not.toBeNull();
    expect(appRedirect.headers.get("set-cookie")).toBeNull();

    // The content host redeems the handoff token into a project-path cookie and redirects
    // to the clean URL, keeping the token out of the address bar and shareable links.
    const redeem = await handler(new Request(handoffUrl.toString(), { redirect: "manual" }));
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get("location")).toBe("/secret/");
    const setCookie = redeem.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Secure-scratchwork_access_secret=");
    expect(setCookie).toContain("Path=/secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0];

    // The clean URL now serves the document with the cookie, without a sandbox CSP.
    const doc = await handler(new Request("https://pages.scratch.test/secret/", {
      headers: { cookie, "sec-fetch-dest": "document" },
    }));
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("private page body");
    expect(doc.headers.get("content-security-policy")).toBeNull();
    expect(doc.headers.get("referrer-policy")).toBe("same-origin");
    expect(doc.headers.get("access-control-allow-origin")).toBeNull();

    // Renderer subresource fetches carry the cookie plus a same-project referer.
    const asset = await handler(new Request("https://pages.scratch.test/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/secret/" },
    }));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("secret");

    // Clients without Sec-Fetch headers (old browsers, curl with the cookie) still work.
    const legacy = await handler(new Request("https://pages.scratch.test/secret/data.json", {
      headers: { cookie },
    }));
    expect(legacy.status).toBe(200);

    // A missing trailing slash canonicalizes onto the cookie's path scope.
    const noSlash = await handler(new Request("https://pages.scratch.test/secret", {
      headers: { cookie },
      redirect: "manual",
    }));
    expect(noSlash.status).toBe(308);
    expect(noSlash.headers.get("location")).toBe("/secret/");
  });

  test("rejects cross-project and unauthenticated access to private content", async () => {
    const authConfig = {
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret-session-secret-32-bytes",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    } as const;
    const token = await Effect.runPromise(createSessionToken(user, authConfig));
    const handler = await appHandler({
      config: {
        appUrl: "https://app.scratch.test",
        contentUrl: "https://pages.scratch.test",
        auth: authConfig,
      },
    });

    for (const project of ["secret", "other"]) {
      const publish = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": `${project} body`, "data.json": "{}" }),
        openPath: "/",
        project,
        visibility: "private",
      }, token));
      expect(publish.status).toBe(200);
    }

    const appRedirect = await handler(new Request(
      "https://app.scratch.test/auth/project?route=secret&returnTo=https%3A%2F%2Fpages.scratch.test%2Fsecret%2F",
      { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    ));
    const handoffUrl = new URL(appRedirect.headers.get("location") ?? "https://invalid");
    const redeem = await handler(new Request(handoffUrl.toString(), { redirect: "manual" }));
    const cookie = (redeem.headers.get("set-cookie") ?? "").split(";")[0];

    // Another project's page cannot fetch private content even with the cookie attached:
    // its referer is outside the project.
    const crossFetch = await handler(new Request("https://pages.scratch.test/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/evil/" },
    }));
    expect(crossFetch.status).toBe(403);

    // Neither can it iframe the project, or strip the referrer to hide where it came from.
    const crossFrame = await handler(new Request("https://pages.scratch.test/secret/", {
      headers: { cookie, "sec-fetch-dest": "iframe", referer: "https://pages.scratch.test/evil/" },
    }));
    expect(crossFrame.status).toBe(403);
    const strippedReferer = await handler(new Request("https://pages.scratch.test/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty" },
    }));
    expect(strippedReferer.status).toBe(403);

    // A cookie minted for one project does not open a different project.
    const crossProject = await handler(new Request("https://pages.scratch.test/other/", {
      headers: { cookie },
      redirect: "manual",
    }));
    expect(crossProject.status).toBe(302);
    expect(new URL(crossProject.headers.get("location") ?? "https://invalid").pathname).toBe("/auth/project");

    // An unauthenticated subresource request fails fast instead of redirecting into OAuth.
    const anonFetch = await handler(new Request("https://pages.scratch.test/secret/data.json", {
      headers: { "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/secret/" },
    }));
    expect(anonFetch.status).toBe(401);

    // A bogus handoff token bounces to the clean URL (re-running the handoff) with no cookie.
    const garbage = await handler(new Request(
      "https://pages.scratch.test/secret/?_scratchwork_handoff=not-a-real-token",
      { redirect: "manual" },
    ));
    expect(garbage.status).toBe(302);
    expect(garbage.headers.get("location")).toBe("/secret/");
    expect(garbage.headers.get("set-cookie")).toBeNull();
  });

  test("renders an account-switch page when a signed-in browser can't access a project", async () => {
    const owner = { id: "owner-1", email: "owner@example.com" };
    const viewer = { id: "viewer-1", email: "viewer@example.com" };
    // Session user is the viewer; API bearer (publish) is the owner.
    const handler = await appHandler({ auth: testAuth(viewer, owner) });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private" }),
      openPath: "/",
      project: "secret",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const pagePath = "/auth/project?route=secret&returnTo=https%3A%2F%2Fscratch.test%2Fsecret%2F";
    const forbidden = await handler(new Request(`https://scratch.test${pagePath}`, {
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    }));
    expect(forbidden.status).toBe(404);
    expect(forbidden.headers.get("content-type")).toContain("text/html");
    const forbiddenHtml = await forbidden.text();
    expect(forbiddenHtml).toContain("Project not available");
    expect(forbiddenHtml).toContain("You&#39;re signed in as viewer@example.com.");
    expect(forbiddenHtml).toContain("Sign in with a different account");
    expect(forbiddenHtml).toContain(`href="/auth/login?returnTo=${encodeURIComponent(pagePath)}"`);

    // A missing project renders the identical page and status, so the page never
    // confirms whether a private project exists.
    const missing = await handler(new Request("https://scratch.test/auth/project?route=nope", {
      headers: { accept: "text/html" },
      redirect: "manual",
    }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Project not available");

    // Non-browser clients keep the masked JSON contract unchanged.
    const jsonForbidden = await handler(new Request(`https://scratch.test${pagePath}`, { redirect: "manual" }));
    expect(jsonForbidden.status).toBe(403);
    expect(await json(jsonForbidden)).toEqual({ error: "Project not found" });
    const jsonMissing = await handler(new Request("https://scratch.test/auth/project?route=nope", { redirect: "manual" }));
    expect(jsonMissing.status).toBe(404);
    expect(await json(jsonMissing)).toEqual({ error: "Project not found" });
  });

  test("escapes user-controlled values on error pages", async () => {
    const viewer = { id: "viewer-1", email: "<img src=x onerror=alert(1)>@example.com" };
    const handler = await appHandler({ auth: testAuth(viewer, viewer) });
    const response = await handler(new Request("https://scratch.test/auth/project?route=nope", {
      headers: { accept: "text/html" },
      redirect: "manual",
    }));
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;@example.com");
  });

  test("serves HTML error pages to browser navigations and JSON to everything else", async () => {
    const handler = await appHandler({ auth: testAuth(user) });

    const browser404 = await handler(new Request("https://scratch.test/missing/", {
      headers: { accept: "text/html,application/xhtml+xml" },
    }));
    expect(browser404.status).toBe(404);
    expect(browser404.headers.get("content-type")).toContain("text/html");
    expect(await browser404.text()).toContain("Page not found");

    const plain404 = await handler(new Request("https://scratch.test/missing/"));
    expect(plain404.status).toBe(404);
    expect(await json(plain404)).toEqual({ error: "Not found" });

    // API routes stay JSON even when a browser navigates to them directly.
    const api404 = await handler(new Request("https://scratch.test/api/nope", {
      headers: { accept: "text/html" },
    }));
    expect(api404.status).toBe(404);
    expect(await json(api404)).toEqual({ error: "Not found" });
  });

  test("binds OAuth callback state to a browser cookie", async () => {
    const handler = await appHandler({
      config: {
        auth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          sessionSecret: "session-secret-session-secret-32-bytes",
          allowedUsers: "public",
          sessionTtlSeconds: 60,
        },
      },
    });
    const login = await handler(new Request("https://scratch.test/auth/login?returnTo=/docs"));
    const location = login.headers.get("location");
    const setCookie = login.headers.get("set-cookie");
    expect(location).toContain("https://accounts.google.com");
    expect(setCookie).toContain("__Host-scratchwork_oauth_state=");

    const state = new URL(location ?? "https://invalid").searchParams.get("state");
    const callback = await handler(new Request(`https://scratch.test/auth/callback/google?code=code&state=${encodeURIComponent(state ?? "")}`));
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("Invalid OAuth state cookie");
  });
});

/** Builds a JSON POST request for app endpoint tests. */
function post(path: string, body: unknown, bearer?: string): Request {
  return new Request(`https://scratch.test${path}`, {
    method: "POST",
    headers: bearer == null
      ? { "content-type": "application/json" }
      : { "authorization": `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
