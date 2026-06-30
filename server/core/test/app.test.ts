import { describe, expect, test } from "bun:test";
import { appHandler, bundle, json, testAuth, type MemoryStoredObject } from "./helpers";

const user = { id: "user-1", email: "founder@example.com" };

describe("server app", () => {
  test("publishes files into per-file storage and serves the site", async () => {
    const storage = new Map<string, MemoryStoredObject>();
    const handler = await appHandler({ storage });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "<h1>Hello</h1>",
        "style.css": "body { color: red; }",
      }),
      openPath: "/",
    }));

    expect(publish.status).toBe(200);
    const body = await json(publish) as { slug: string; token: string; url: string };
    expect(body.slug).toMatch(/^[a-z0-9][a-z0-9-]{2,63}$/);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    expect(body.url).toBe(`https://scratch.test/${body.slug}/`);
    expect([...storage.keys()].some((key) => key.startsWith("blobs/sha256/"))).toBe(true);
    expect([...storage.keys()].some((key) => key === `sites/${body.slug}/site.v2.json`)).toBe(true);
    expect(new TextDecoder().decode(storage.get(`sites/${body.slug}/site.v2.json`)?.body)).not.toContain("contentBase64");

    const html = await handler(new Request(`https://scratch.test/${body.slug}/`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(await html.text()).toContain("Hello");

    const css = await handler(new Request(`https://scratch.test/${body.slug}/style.css`));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("body { color: red; }");
  });

  test("republishes by flipping the current revision", async () => {
    const handler = await appHandler();
    const first = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "old", "old.css": "old" }),
      openPath: "/",
    }))) as { slug: string; token: string };

    const wrong = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "bad" }),
      openPath: "/",
      slug: first.slug,
      token: "wrong-token-wrong-token",
    }));
    expect(wrong.status).toBe(403);

    const second = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "new" }),
      openPath: "/",
      slug: first.slug,
      token: first.token,
    }));
    expect(second.status).toBe(200);

    const html = await handler(new Request(`https://scratch.test/${first.slug}/`));
    expect(await html.text()).toContain("new");
    const removed = await handler(new Request(`https://scratch.test/${first.slug}/old.css`));
    expect(removed.status).toBe(404);
  });

  test("serves rendered markdown with sandbox and public asset CORS", async () => {
    const handler = await appHandler();
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "index.md": "# Hello" }),
      openPath: "/",
    }))) as { slug: string };

    const html = await handler(new Request(`https://scratch.test/${published.slug}/`));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect(html.headers.get("access-control-allow-origin")).toBe("*");

    const markdown = await handler(new Request(`https://scratch.test/${published.slug}/index.md`));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("sandboxes published SVG assets", async () => {
    const handler = await appHandler();
    const published = await json(await handler(post("/api/publish", {
      bundle: bundle({ "evil.svg": "<svg><script>alert(1)</script></svg>" }),
      openPath: "/evil.svg",
    }))) as { slug: string };

    const svg = await handler(new Request(`https://scratch.test/${published.slug}/evil.svg`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("requires bearer auth for publish when auth is enabled", async () => {
    const handler = await appHandler({ auth: testAuth(user, null) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
    }));

    expect(response.status).toBe(401);
  });

  test("rejects reserved slugs", async () => {
    const handler = await appHandler();
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      slug: "api",
      token: "valid-token-valid-token",
    }));

    expect(response.status).toBe(400);
  });

  test("binds OAuth callback state to a browser cookie", async () => {
    const handler = await appHandler({
      config: {
        auth: {
          _tag: "Google",
          clientId: "client-id",
          clientSecret: "client-secret",
          sessionSecret: "session-secret-session-secret-32-bytes",
          allowedEmails: new Set(),
          allowedDomains: new Set(),
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
function post(path: string, body: unknown): Request {
  return new Request(`https://scratch.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
