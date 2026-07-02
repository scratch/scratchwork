import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createSessionToken } from "../src/auth";
import { appHandler, bundle, json, testAuth, type MemoryStoredObject } from "./helpers";

const user = { id: "user-1", email: "founder@example.com" };

describe("server app", () => {
  test("publishes files into per-file storage and serves the site", async () => {
    const storage = new Map<string, MemoryStoredObject>();
    const handler = await appHandler({ storage, auth: testAuth(user), config: { projectPath: "workspace/project" } });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "<h1>Hello</h1>",
        "style.css": "body { color: red; }",
      }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));

    expect(publish.status).toBe(200);
    const body = await json(publish) as { workspace: string; project: string; routePath: string; url: string };
    expect(body.workspace).toBe("demo");
    expect(body.project).toBe("site");
    expect(body.routePath).toBe("demo/site");
    expect(body.url).toBe("https://scratch.test/demo/site/");
    expect([...storage.keys()].some((key) => key.startsWith("blobs/sha256/"))).toBe(true);
    const revisionKey = [...storage.keys()].find((key) => key.startsWith("projects/demo/site/revisions/"));
    expect(typeof revisionKey).toBe("string");
    expect(new TextDecoder().decode(storage.get(revisionKey ?? "")?.body)).not.toContain("contentBase64");

    const html = await handler(new Request("https://scratch.test/demo/site/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBeNull();
    expect(html.headers.get("referrer-policy")).toBe("same-origin");
    expect(await html.text()).toContain("Hello");

    const css = await handler(new Request("https://scratch.test/demo/site/style.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("body { color: red; }");

    const encodedSlash = await handler(new Request("https://scratch.test/demo%2Fsite", { redirect: "manual" }));
    expect(encodedSlash.status).toBe(404);

    const encodedSegment = await handler(new Request("https://scratch.test/de%6Do/site/style.css"));
    expect(encodedSegment.status).toBe(200);
    expect(encodedSegment.headers.get("content-type")).toContain("text/css");
  });

  test("republishes by flipping the current revision", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    const first = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "old", "old.css": "old" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));
    expect(first.status).toBe(200);

    const second = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "new" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));
    expect(second.status).toBe(200);

    const html = await handler(new Request("https://scratch.test/demo/site/"));
    expect(await html.text()).toContain("new");
    const removed = await handler(new Request("https://scratch.test/demo/site/old.css"));
    expect(removed.status).toBe(404);
  });

  test("serves rendered markdown unsandboxed with public asset CORS", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.md": "# Hello", "evil.svg": "<svg><script>alert(1)</script></svg>" }),
      openPath: "/",
      workspace: "demo",
      project: "docs",
      visibility: "public",
    }))) as { routePath: string };

    const html = await handler(new Request(`https://scratch.test/${published.routePath}/`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toBeNull();
    expect(html.headers.get("access-control-allow-origin")).toBe("*");

    const markdown = await handler(new Request(`https://scratch.test/${published.routePath}/index.md`));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("access-control-allow-origin")).toBe("*");

    const svg = await handler(new Request(`https://scratch.test/${published.routePath}/evil.svg`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy")).toBeNull();
  });

  test("republishing without visibility preserves the project's visibility", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project", defaultVisibility: "private" } });
    const first = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v1" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));
    expect(first.status).toBe(200);

    const second = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "v2" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
    }));
    expect(second.status).toBe(200);
    expect(((await json(second)) as { visibility: string }).visibility).toBe("public");

    const html = await handler(new Request("https://scratch.test/demo/site/"));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("v2");
  });

  test("rejects reserved slugs that would shadow server routes", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    for (const workspace of ["api", "auth", "health"]) {
      const response = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": "hello" }),
        openPath: "/",
        workspace,
        project: "docs",
        visibility: "public",
      }));
      expect(response.status).toBe(400);
    }

    const usernameHandler = await appHandler({
      auth: testAuth({ id: "user-2", email: "api@example.com" }),
      config: { projectPath: "username/project" },
    });
    const shadowed = await usernameHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "docs",
      visibility: "public",
    }));
    expect(shadowed.status).toBe(400);
  });

  test("resolves published content paths to their project", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }))) as { workspace: string; routePath: string };
    expect(published.routePath).not.toContain("/");

    const resolved = await handler(new Request(`https://scratch.test/api/resolve?path=${encodeURIComponent(`/${published.routePath}/index.html`)}`));
    expect(resolved.status).toBe(200);
    const body = await json(resolved) as { project: { workspace: string; project: string } };
    expect(body.project.workspace).toBe(published.workspace);
    expect(body.project.project).toBe("site");

    const missing = await handler(new Request("https://scratch.test/api/resolve?path=/no-such-route/"));
    expect(missing.status).toBe(404);

    const unauthenticated = await appHandler({ auth: testAuth(user, null), storage: undefined });
    const denied = await unauthenticated(new Request(`https://scratch.test/api/resolve?path=/${published.routePath}/`));
    expect(denied.status).toBe(401);
  });

  test("rejects publishes without a workspace when defaultWorkspace is required", async () => {
    const handler = await appHandler({
      auth: testAuth(user),
      config: { defaultWorkspace: "required", projectPath: "workspace/project" },
    });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "workspace is required" });
  });

  test("lists projects beyond a single database page", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    for (let index = 0; index < 120; index += 1) {
      const published = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": "hello" }),
        openPath: "/",
        workspace: "demo",
        project: `site-${String(index).padStart(3, "0")}`,
        visibility: "public",
      }));
      expect(published.status).toBe(200);
    }

    const response = await handler(new Request("https://scratch.test/api/projects"));
    expect(response.status).toBe(200);
    const body = await json(response) as { projects: ReadonlyArray<{ project: string }> };
    expect(body.projects).toHaveLength(120);
  });

  test("requires bearer auth for publish when auth is enabled", async () => {
    const handler = await appHandler({ auth: testAuth(user, null) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
    }));

    expect(response.status).toBe(401);
  });

  test("rejects visibility above the server ceiling", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { maxVisibility: "@example.com" } });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      workspace: "demo",
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
      workspace: "demo",
      project: "site",
      visibility: "public",
    }));

    expect(response.status).toBe(403);
  });

  test("redirects private content readers through app-domain project auth", async () => {
    const handler = await appHandler({
      auth: testAuth(null, user),
      config: {
        appUrl: "https://app.scratch.test",
        contentUrl: "https://pages.scratch.test",
        projectPath: "workspace/project",
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private" }),
      openPath: "/",
      workspace: "demo",
      project: "secret",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const response = await handler(new Request("https://pages.scratch.test/demo/secret/", { redirect: "manual" }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    expect(location.origin).toBe("https://app.scratch.test");
    expect(location.pathname).toBe("/auth/project");
    expect(location.searchParams.get("route")).toBe("demo/secret");
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
        projectPath: "workspace/project",
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "private",
        "hello-world.svg": "<svg></svg>",
      }),
      openPath: "/",
      workspace: "demo",
      project: "secret",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const response = await handler(new Request("http://scratchwork.local/demo/secret/hello-world.svg", {
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
    expect(location.searchParams.get("route")).toBe("demo/secret");
    expect(location.searchParams.get("returnTo")).toBe("https://pages.scratch.test/demo/secret/hello-world.svg");
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
        projectPath: "workspace/project",
        auth: authConfig,
      },
    });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private page body", "data.json": "{\"secret\":true}" }),
      openPath: "/",
      workspace: "demo",
      project: "secret",
      visibility: "private",
    }, token));
    expect(publish.status).toBe(200);

    // The app host authenticates the viewer and redirects back with a one-time handoff
    // token in the query string; the app response itself sets no content cookie.
    const appRedirect = await handler(new Request(
      "https://app.scratch.test/auth/project?route=demo/secret&returnTo=https%3A%2F%2Fpages.scratch.test%2Fdemo%2Fsecret%2F",
      { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    ));
    expect(appRedirect.status).toBe(302);
    const handoffUrl = new URL(appRedirect.headers.get("location") ?? "https://invalid");
    expect(handoffUrl.origin).toBe("https://pages.scratch.test");
    expect(handoffUrl.pathname).toBe("/demo/secret/");
    expect(handoffUrl.searchParams.get("_scratchwork_handoff")).not.toBeNull();
    expect(appRedirect.headers.get("set-cookie")).toBeNull();

    // The content host redeems the handoff token into a project-path cookie and redirects
    // to the clean URL, keeping the token out of the address bar and shareable links.
    const redeem = await handler(new Request(handoffUrl.toString(), { redirect: "manual" }));
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get("location")).toBe("/demo/secret/");
    const setCookie = redeem.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Secure-scratchwork_access_demo_secret=");
    expect(setCookie).toContain("Path=/demo/secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0];

    // The clean URL now serves the document with the cookie, without a sandbox CSP.
    const doc = await handler(new Request("https://pages.scratch.test/demo/secret/", {
      headers: { cookie, "sec-fetch-dest": "document" },
    }));
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("private page body");
    expect(doc.headers.get("content-security-policy")).toBeNull();
    expect(doc.headers.get("referrer-policy")).toBe("same-origin");
    expect(doc.headers.get("access-control-allow-origin")).toBeNull();

    // Renderer subresource fetches carry the cookie plus a same-project referer.
    const asset = await handler(new Request("https://pages.scratch.test/demo/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/demo/secret/" },
    }));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("secret");

    // Clients without Sec-Fetch headers (old browsers, curl with the cookie) still work.
    const legacy = await handler(new Request("https://pages.scratch.test/demo/secret/data.json", {
      headers: { cookie },
    }));
    expect(legacy.status).toBe(200);

    // A missing trailing slash canonicalizes onto the cookie's path scope.
    const noSlash = await handler(new Request("https://pages.scratch.test/demo/secret", {
      headers: { cookie },
      redirect: "manual",
    }));
    expect(noSlash.status).toBe(308);
    expect(noSlash.headers.get("location")).toBe("/demo/secret/");
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
        projectPath: "workspace/project",
        auth: authConfig,
      },
    });

    for (const project of ["secret", "other"]) {
      const publish = await handler(post("/api/publish", {
        bundle: bundle({ "index.html": `${project} body`, "data.json": "{}" }),
        openPath: "/",
        workspace: "demo",
        project,
        visibility: "private",
      }, token));
      expect(publish.status).toBe(200);
    }

    const appRedirect = await handler(new Request(
      "https://app.scratch.test/auth/project?route=demo/secret&returnTo=https%3A%2F%2Fpages.scratch.test%2Fdemo%2Fsecret%2F",
      { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    ));
    const handoffUrl = new URL(appRedirect.headers.get("location") ?? "https://invalid");
    const redeem = await handler(new Request(handoffUrl.toString(), { redirect: "manual" }));
    const cookie = (redeem.headers.get("set-cookie") ?? "").split(";")[0];

    // Another project's page cannot fetch private content even with the cookie attached:
    // its referer is outside the project.
    const crossFetch = await handler(new Request("https://pages.scratch.test/demo/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/evil/" },
    }));
    expect(crossFetch.status).toBe(403);

    // Neither can it iframe the project, or strip the referrer to hide where it came from.
    const crossFrame = await handler(new Request("https://pages.scratch.test/demo/secret/", {
      headers: { cookie, "sec-fetch-dest": "iframe", referer: "https://pages.scratch.test/evil/" },
    }));
    expect(crossFrame.status).toBe(403);
    const strippedReferer = await handler(new Request("https://pages.scratch.test/demo/secret/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty" },
    }));
    expect(strippedReferer.status).toBe(403);

    // A cookie minted for demo/secret does not open a different project.
    const crossProject = await handler(new Request("https://pages.scratch.test/demo/other/", {
      headers: { cookie },
      redirect: "manual",
    }));
    expect(crossProject.status).toBe(302);
    expect(new URL(crossProject.headers.get("location") ?? "https://invalid").pathname).toBe("/auth/project");

    // An unauthenticated subresource request fails fast instead of redirecting into OAuth.
    const anonFetch = await handler(new Request("https://pages.scratch.test/demo/secret/data.json", {
      headers: { "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/demo/secret/" },
    }));
    expect(anonFetch.status).toBe(401);

    // A bogus handoff token bounces to the clean URL (re-running the handoff) with no cookie.
    const garbage = await handler(new Request(
      "https://pages.scratch.test/demo/secret/?_scratchwork_handoff=not-a-real-token",
      { redirect: "manual" },
    ));
    expect(garbage.status).toBe(302);
    expect(garbage.headers.get("location")).toBe("/demo/secret/");
    expect(garbage.headers.get("set-cookie")).toBeNull();
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
