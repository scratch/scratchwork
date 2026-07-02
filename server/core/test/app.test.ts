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
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
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

  test("serves rendered markdown with sandbox and public asset CORS", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.md": "# Hello" }),
      openPath: "/",
      workspace: "demo",
      project: "docs",
      visibility: "public",
    }))) as { routePath: string };

    const html = await handler(new Request(`https://scratch.test/${published.routePath}/`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(html.headers.get("access-control-allow-origin")).toBe("*");

    const markdown = await handler(new Request(`https://scratch.test/${published.routePath}/index.md`));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("sandboxes published SVG assets", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: { projectPath: "workspace/project" } });
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "evil.svg": "<svg><script>alert(1)</script></svg>" }),
      openPath: "/evil.svg",
      workspace: "demo",
      project: "svg",
      visibility: "public",
    }))) as { routePath: string };

    const svg = await handler(new Request(`https://scratch.test/${published.routePath}/evil.svg`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
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

  test("issues a content cookie through the private project access handoff", async () => {
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
      bundle: bundle({ "index.html": "private" }),
      openPath: "/",
      workspace: "demo",
      project: "secret",
      visibility: "private",
    }, token));
    expect(publish.status).toBe(200);

    const appRedirect = await handler(new Request(
      "https://app.scratch.test/auth/project?route=demo/secret&returnTo=https%3A%2F%2Fpages.scratch.test%2Fdemo%2Fsecret%2F",
      { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    ));
    expect(appRedirect.status).toBe(302);
    const contentWithToken = appRedirect.headers.get("location") ?? "";
    expect(contentWithToken).toContain("scratchwork_access=");

    const setCookie = await handler(new Request(contentWithToken, { redirect: "manual" }));
    expect(setCookie.status).toBe(302);
    const cookie = setCookie.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("scratchwork_project_access=");
    expect(cookie).toContain("Path=/demo/secret");

    const content = await handler(new Request("https://pages.scratch.test/demo/secret/", { headers: { cookie } }));
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("private");
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
