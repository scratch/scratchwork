/*
 * The comments route policy matrix (AGENTS.md, invariant 4, applied to the
 * content-origin comments API): for every route in COMMENTS_ROUTES × credential
 * kind (no cookie, garbage cookie, stranger, reader, writer, admin, owner) the
 * expected outcome is derived from the declared policy — cookie auth, the read
 * floor, and the author-or-writer rule on edits/deletes. Also pins the
 * existence masking (missing, public, and comments-disabled projects answer
 * identically), the origin/referer guards, widget injection, publish-time
 * validation of the comments+public combination, and the delete-time purge.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { makeAuth, createSessionToken, type AuthUser } from "../src/auth";
import { COMMENTS_ROUTES } from "../src/comments-routes";
import type { AuthConfig } from "../src/config";
import { appHandler, bundle, json } from "./helpers";

/** Must match the appHandler defaults in helpers.ts so minted tokens verify. */
const authConfig: AuthConfig = {
  mode: "oauth",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  sessionSecret: "test-session-secret-test-session-secret",
  allowedUsers: "public",
  sessionTtlSeconds: 60,
};

const users = {
  owner: { id: "owner-1", email: "owner@example.com" },
  admin: { id: "admin-1", email: "admin@example.com" },
  writer: { id: "writer-1", email: "writer@example.com" },
  reader: { id: "reader-1", email: "reader@example.com" },
  reader2: { id: "reader-2", email: "reader2@example.com" },
  stranger: { id: "stranger-1", email: "stranger@example.com" },
} satisfies Record<string, AuthUser>;

const auth = makeAuth(authConfig);

/** Mints the path-scoped access cookie a real private-content viewer holds. */
async function accessCookie(user: AuthUser, project: string): Promise<string> {
  const token = await Effect.runPromise(auth.issueProjectAccessToken(project, user, "cookie"));
  return `__Secure-scratchwork_access_${project}=${encodeURIComponent(token)}`;
}

/** A fresh server with three projects: "site" (private, comments on, the
 * standard grants), "plain" (private, comments off), "pub" (public). */
async function fixture() {
  const handler = await appHandler({});
  const ownerToken = await Effect.runPromise(createSessionToken(users.owner, authConfig));
  const post = (path: string, body: unknown) =>
    handler(new Request(`https://scratch.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  for (const [project, isPublic, commentsEnabled] of [
    ["site", false, true],
    ["plain", false, false],
    ["pub", true, false],
  ] as const) {
    const published = await post("/api/publish", {
      bundle: bundle({ "index.html": "<html><body>hello</body></html>", "notes.md": "# notes" }),
      openPath: "/",
      project,
      isPublic,
      commentsEnabled,
    });
    if (published.status !== 200) throw new Error(`fixture publish failed: ${await published.text()}`);
  }
  for (const [role, user] of [["read", users.reader], ["read", users.reader2], ["write", users.writer], ["admin", users.admin]] as const) {
    const shared = await post("/api/projects/site/share", { role, add: [user.email] });
    if (shared.status !== 200) throw new Error(`fixture share failed: ${await shared.text()}`);
  }
  return { handler, ownerToken };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Calls a comments route as a viewer holding the given cookie. */
async function call(
  fx: Fixture,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie != null) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fx.handler(new Request(`https://scratch.test${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
}

/** Creates one comment as `author` and returns its wire form. */
async function createComment(fx: Fixture, author: AuthUser, body = "first!"): Promise<{ id: string }> {
  const response = await call(fx, "POST", "/site/__scratchwork/comments", {
    cookie: await accessCookie(author, "site"),
    body: { page: "/", body, anchors: [{ selector: "body", x: 10, y: 20 }] },
  });
  expect(response.status).toBe(200);
  return (await json(response) as { comment: { id: string } }).comment;
}

/** A success-shaped request per registered route (the completeness check pins this). */
const FIXTURES: Record<string, (commentId: string) => { method: string; path: string; body?: unknown }> = {
  "comments-widget": () => ({ method: "GET", path: "/site/__scratchwork/comments/widget.js" }),
  "comments-list": () => ({ method: "GET", path: "/site/__scratchwork/comments?page=/" }),
  "comments-create": () => ({
    method: "POST",
    path: "/site/__scratchwork/comments",
    body: { page: "/", body: "hello", anchors: [{ selector: "body", x: 1, y: 2 }] },
  }),
  "comments-update": (commentId) => ({
    method: "PATCH",
    path: `/site/__scratchwork/comments/${commentId}`,
    body: { page: "/", resolved: true },
  }),
  "comments-delete": (commentId) => ({
    method: "DELETE",
    path: `/site/__scratchwork/comments/${commentId}?page=/`,
  }),
};

describe("comments route policy matrix", () => {
  test("every registered route has a request fixture, and no fixture is stale", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(COMMENTS_ROUTES.map((route) => route.name).sort());
    expect(new Set(COMMENTS_ROUTES.map((r) => r.name)).size).toBe(COMMENTS_ROUTES.length);
  });

  for (const route of COMMENTS_ROUTES) {
    test(`${route.name} requires an authenticated read-authorized viewer`, async () => {
      const fx = await fixture();
      const comment = await createComment(fx, users.reader);
      const shape = FIXTURES[route.name]!(comment.id);

      // No cookie, a garbage cookie, and a cookie minted for a user without
      // read access must all be 401: the route reveals nothing without a
      // verified, currently-authorized viewer.
      for (const cookie of [
        undefined,
        "__Secure-scratchwork_access_site=garbage.token",
        await accessCookie(users.stranger, "site"),
      ]) {
        const response = await call(fx, shape.method, shape.path, { cookie, body: shape.body });
        expect({ route: route.name, cookie: cookie ?? "none", status: response.status })
          .toEqual({ route: route.name, cookie: cookie ?? "none", status: 401 });
      }

      // A cookie scoped to a different project never transfers.
      const wrongProject = await call(fx, shape.method, shape.path, {
        cookie: await accessCookie(users.owner, "plain"),
        body: shape.body,
      });
      expect({ route: route.name, status: wrongProject.status }).toEqual({ route: route.name, status: 401 });

      // A reader passes the gate (route-specific rules are pinned below).
      const reader = await call(fx, shape.method, shape.path, {
        cookie: await accessCookie(users.reader, "site"),
        body: shape.body,
      });
      expect({ route: route.name, status: reader.status }).toEqual({ route: route.name, status: 200 });
    });

    test(`${route.name} rejects cross-origin browser calls even from the owner`, async () => {
      const fx = await fixture();
      const comment = await createComment(fx, users.owner);
      const shape = FIXTURES[route.name]!(comment.id);
      const cookie = await accessCookie(users.owner, "site");
      const crossOriginHeaders: ReadonlyArray<Record<string, string>> = [
        { origin: "https://evil.example" },
        { "sec-fetch-site": "cross-site" },
      ];
      for (const headers of crossOriginHeaders) {
        const response = await call(fx, shape.method, shape.path, { cookie, body: shape.body, headers });
        expect({ route: route.name, headers, status: response.status })
          .toEqual({ route: route.name, headers, status: 403 });
      }
    });

    test(`${route.name} rejects subresource requests initiated outside the project`, async () => {
      const fx = await fixture();
      const comment = await createComment(fx, users.owner);
      const shape = FIXTURES[route.name]!(comment.id);
      const cookie = await accessCookie(users.owner, "site");
      const blocked = await call(fx, shape.method, shape.path, {
        cookie,
        body: shape.body,
        headers: { "sec-fetch-dest": "empty", referer: "https://scratch.test/plain/" },
      });
      expect({ route: route.name, status: blocked.status }).toEqual({ route: route.name, status: 403 });
      const allowed = await call(fx, shape.method, shape.path, {
        cookie,
        body: shape.body,
        headers: { "sec-fetch-dest": "empty", referer: "https://scratch.test/site/notes" },
      });
      expect({ route: route.name, status: allowed.status }).toEqual({ route: route.name, status: 200 });
    });
  }

  test("missing, comments-disabled, and public projects answer identically (existence masked)", async () => {
    const fx = await fixture();
    const cookie = await accessCookie(users.owner, "site");
    for (const project of ["missing", "plain", "pub"]) {
      const response = await call(fx, "GET", `/${project}/__scratchwork/comments?page=/`, { cookie });
      expect({ project, status: response.status }).toEqual({ project, status: 404 });
      expect(await json(response)).toEqual({ error: "Not found" });
    }
  });

  test("the whole __scratchwork prefix is server-owned: unknown paths 404, wrong methods 405", async () => {
    const fx = await fixture();
    const cookie = await accessCookie(users.owner, "site");
    for (const path of [
      "/site/__scratchwork",
      "/site/__scratchwork/",
      "/site/__scratchwork/other",
      "/site/__scratchwork/comments/not-a-comment-id",
      "/site/__scratchwork/comments/widget.js/extra",
    ]) {
      const response = await call(fx, "GET", path, { cookie });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    const put = await call(fx, "PUT", "/site/__scratchwork/comments", { cookie, body: {} });
    expect(put.status).toBe(405);
    const comment = await createComment(fx, users.owner);
    const postItem = await call(fx, "POST", `/site/__scratchwork/comments/${comment.id}`, { cookie, body: {} });
    expect(postItem.status).toBe(405);
  });

  test("readers may resolve and reopen anyone's comment, but not edit or delete it", async () => {
    const fx = await fixture();
    const comment = await createComment(fx, users.owner, "owner's comment");
    const cookie = await accessCookie(users.reader, "site");

    const resolve = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie, body: { page: "/", resolved: true },
    });
    expect(resolve.status).toBe(200);
    const resolved = (await json(resolve) as { comment: { resolved: boolean; resolvedBy?: string } }).comment;
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedBy).toBe(users.reader.email);

    const reopen = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie, body: { page: "/", resolved: false },
    });
    expect(((await json(reopen)) as { comment: { resolvedBy?: string } }).comment.resolvedBy).toBeUndefined();

    const edit = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie, body: { page: "/", body: "defaced" },
    });
    expect(edit.status).toBe(403);
    const remove = await call(fx, "DELETE", `/site/__scratchwork/comments/${comment.id}?page=/`, { cookie });
    expect(remove.status).toBe(403);
  });

  test("authors edit and delete their own comments; writers moderate everyone's", async () => {
    const fx = await fixture();
    const comment = await createComment(fx, users.reader, "reader's comment");

    const own = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie: await accessCookie(users.reader, "site"),
      body: { page: "/", body: "reader's edit" },
    });
    expect(own.status).toBe(200);

    // Another reader cannot touch it; a writer can.
    const other = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie: await accessCookie(users.reader2, "site"),
      body: { page: "/", body: "reader2's edit" },
    });
    expect(other.status).toBe(403);
    const moderated = await call(fx, "PATCH", `/site/__scratchwork/comments/${comment.id}`, {
      cookie: await accessCookie(users.writer, "site"),
      body: { page: "/", body: "writer's edit" },
    });
    expect(moderated.status).toBe(200);
    const removed = await call(fx, "DELETE", `/site/__scratchwork/comments/${comment.id}?page=/`, {
      cookie: await accessCookie(users.writer, "site"),
    });
    expect(removed.status).toBe(200);

    const list = await call(fx, "GET", "/site/__scratchwork/comments?page=/", {
      cookie: await accessCookie(users.reader, "site"),
    });
    expect((await json(list) as { comments: unknown[] }).comments).toEqual([]);
  });

  test("list reports the viewer's own standing and page comments oldest first", async () => {
    const fx = await fixture();
    await createComment(fx, users.owner, "one");
    await createComment(fx, users.reader, "two");
    const response = await call(fx, "GET", "/site/__scratchwork/comments?page=/", {
      cookie: await accessCookie(users.reader, "site"),
    });
    const body = await json(response) as {
      viewer: { email: string; canModerate: boolean };
      comments: Array<{ body: string; author: { email: string } }>;
    };
    expect(body.viewer).toEqual({ email: users.reader.email, canModerate: false });
    expect(body.comments.map((comment) => comment.body)).toEqual(["one", "two"]);

    const asWriter = await call(fx, "GET", "/site/__scratchwork/comments?page=/", {
      cookie: await accessCookie(users.writer, "site"),
    });
    expect((await json(asWriter) as { viewer: { canModerate: boolean } }).viewer.canModerate).toBe(true);
  });

  test("page paths normalize, so index.html spellings share one comment set", async () => {
    const fx = await fixture();
    const cookie = await accessCookie(users.owner, "site");
    const created = await call(fx, "POST", "/site/__scratchwork/comments", {
      cookie,
      body: { page: "/docs/index.html", body: "hello", anchors: [{ selector: "body", x: 0, y: 0 }] },
    });
    expect(created.status).toBe(200);
    const list = await call(fx, "GET", "/site/__scratchwork/comments?page=/docs/", { cookie });
    expect((await json(list) as { comments: Array<{ page: string }> }).comments.map((comment) => comment.page))
      .toEqual(["/docs"]);
    const bad = await call(fx, "GET", "/site/__scratchwork/comments?page=../evil", { cookie });
    expect(bad.status).toBe(400);
  });

  test("comment bodies and anchors are validated and capped", async () => {
    const fx = await fixture();
    const cookie = await accessCookie(users.owner, "site");
    const cases: Array<{ label: string; body: unknown }> = [
      { label: "empty body", body: { page: "/", body: "", anchors: [{ selector: "body", x: 0, y: 0 }] } },
      { label: "oversized body", body: { page: "/", body: "x".repeat(5001), anchors: [{ selector: "body", x: 0, y: 0 }] } },
      { label: "no anchors", body: { page: "/", body: "hi", anchors: [] } },
      { label: "unknown field", body: { page: "/", body: "hi", anchors: [{ selector: "body", x: 0, y: 0 }], extra: 1 } },
      { label: "non-finite anchor", body: { page: "/", body: "hi", anchors: [{ selector: "body", x: null, y: 0 }] } },
    ];
    for (const { label, body } of cases) {
      const response = await call(fx, "POST", "/site/__scratchwork/comments", { cookie, body });
      expect({ label, status: response.status }).toEqual({ label, status: 400 });
    }
  });

  test("the widget script is injected only into private comments-enabled HTML pages", async () => {
    const fx = await fixture();
    const marker = "/__scratchwork/comments/widget.js";

    const withComments = await call(fx, "GET", "/site/", {
      cookie: await accessCookie(users.reader, "site"),
    });
    expect(withComments.status).toBe(200);
    expect(await withComments.text()).toContain(`src="/site${marker}"`);

    const rendered = await call(fx, "GET", "/site/notes", {
      cookie: await accessCookie(users.reader, "site"),
    });
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain(`src="/site${marker}"`);

    const plain = await call(fx, "GET", "/plain/", {
      cookie: await accessCookie(users.owner, "plain"),
    });
    expect(plain.status).toBe(200);
    expect(await plain.text()).not.toContain(marker);

    const pub = await call(fx, "GET", "/pub/", {});
    expect(pub.status).toBe(200);
    expect(await pub.text()).not.toContain(marker);
  });

  test("the widget script serves as JavaScript to authorized viewers", async () => {
    const fx = await fixture();
    const response = await call(fx, "GET", "/site/__scratchwork/comments/widget.js", {
      cookie: await accessCookie(users.reader, "site"),
      headers: { "sec-fetch-dest": "script", referer: "https://scratch.test/site/" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("__scratchwork/comments");
  });

  test("publish rejects comments on a public project, and flips stay admin-only", async () => {
    const fx = await fixture();
    const publish = (token: string, body: Record<string, unknown>) =>
      fx.handler(new Request("https://scratch.test/api/publish", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ bundle: bundle({ "index.html": "v2" }), openPath: "/", ...body }),
      }));

    const ownerToken = fx.ownerToken;
    const conflicting = await publish(ownerToken, { project: "with-comments", isPublic: true, commentsEnabled: true });
    expect(conflicting.status).toBe(400);
    expect(((await json(conflicting)) as { error: string }).error).toContain("private");

    // Making a comments-enabled project public must fail too (setting preserved).
    const flipPublic = await publish(ownerToken, { project: "site", isPublic: true });
    expect(flipPublic.status).toBe(400);

    // A writer can republish content but cannot flip the comments toggle.
    const writerToken = await Effect.runPromise(createSessionToken(users.writer, authConfig));
    const writerRepublish = await publish(writerToken, { project: "site" });
    expect(writerRepublish.status).toBe(200);
    const writerFlip = await publish(writerToken, { project: "site", commentsEnabled: false });
    expect(writerFlip.status).toBe(403);

    // Files under the reserved prefix are rejected at publish time.
    const reserved = await fx.handler(new Request("https://scratch.test/api/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        bundle: bundle({ "__scratchwork/evil.js": "x" }),
        openPath: "/",
        project: "reserved-path",
      }),
    }));
    expect(reserved.status).toBe(400);
    expect(((await json(reserved)) as { error: string }).error).toContain("Reserved site path");
  });

  test("deleting a project purges its comments, so a reclaimed name starts clean", async () => {
    const fx = await fixture();
    await createComment(fx, users.owner, "leftover");
    const removed = await fx.handler(new Request("https://scratch.test/api/projects/site", {
      method: "DELETE",
      headers: { authorization: `Bearer ${fx.ownerToken}` },
    }));
    expect(removed.status).toBe(200);

    const republished = await fx.handler(new Request("https://scratch.test/api/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${fx.ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        bundle: bundle({ "index.html": "reborn" }),
        openPath: "/",
        project: "site",
        commentsEnabled: true,
      }),
    }));
    expect(republished.status).toBe(200);

    const list = await call(fx, "GET", "/site/__scratchwork/comments?page=/", {
      cookie: await accessCookie(users.owner, "site"),
    });
    expect((await json(list) as { comments: unknown[] }).comments).toEqual([]);
  });

  test("project info reports commentsEnabled through the shared contract", async () => {
    const fx = await fixture();
    const info = await fx.handler(new Request("https://scratch.test/api/projects/site", {
      headers: { authorization: `Bearer ${fx.ownerToken}` },
    }));
    expect(((await json(info)) as { project: { commentsEnabled: boolean } }).project.commentsEnabled).toBe(true);
  });
});
