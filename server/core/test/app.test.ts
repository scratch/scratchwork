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

  test("share grants access and revoke removes it", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));
    expect(publish.status).toBe(200);

    const share = await handler(post("/api/projects/site/share", { add: ["Alice@Example.com", "@team.example.com"] }));
    expect(share.status).toBe(200);
    const shared = await json(share) as {
      project: { visibility: string; permissions: { read: string[]; write: string[]; admin: string[] } };
      warnings: string[];
    };
    expect(shared.project.visibility).toBe("private");
    expect(shared.project.permissions).toEqual({ read: ["alice@example.com", "@team.example.com"], write: [], admin: [] });
    expect(shared.warnings).toEqual([]);

    // Re-granting an existing target is idempotent.
    const again = await handler(post("/api/projects/site/share", { add: ["alice@example.com"] }));
    expect(((await json(again)) as { project: { permissions: { read: string[] } } }).project.permissions.read)
      .toEqual(["alice@example.com", "@team.example.com"]);

    const revoke = await handler(post("/api/projects/site/share", { remove: ["alice@example.com"] }));
    expect(((await json(revoke)) as { project: { permissions: { read: string[] } } }).project.permissions.read)
      .toEqual(["@team.example.com"]);

    const last = await handler(post("/api/projects/site/share", { remove: ["@team.example.com"] }));
    const cleared = await json(last) as { project: { visibility: string; permissions: { read: string[] } } };
    expect(cleared.project.visibility).toBe("private");
    expect(cleared.project.permissions.read).toEqual([]);
  });

  test("revoke warns when the address keeps access anyway", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));
    await handler(post("/api/projects/site/share", { add: ["alice@corp.example.com", "@corp.example.com"] }));

    const covered = await handler(post("/api/projects/site/share", { remove: ["alice@corp.example.com"] }));
    const coveredBody = await json(covered) as { project: { permissions: { read: string[] } }; warnings: string[] };
    expect(coveredBody.project.permissions.read).toEqual(["@corp.example.com"]);
    expect(coveredBody.warnings).toEqual([
      "alice@corp.example.com still has read access through remaining grants",
    ]);

    const owner = await handler(post("/api/projects/site/share", { remove: [user.email] }));
    const ownerBody = await json(owner) as { warnings: string[] };
    expect(ownerBody.warnings).toEqual(["founder@example.com owns this project and always has access"]);
  });

  test("share assigns roles and moves targets between them", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));

    const write = await handler(post("/api/projects/site/share", { add: ["alice@example.com"], role: "write" }));
    expect(write.status).toBe(200);
    const written = await json(write) as {
      project: { visibility: string; permissions: { read: string[]; write: string[]; admin: string[] } };
    };
    expect(written.project.visibility).toBe("private");
    expect(written.project.permissions).toEqual({ read: [], write: ["alice@example.com"], admin: [] });

    // Re-sharing with a different role moves the target, never duplicates it.
    const admin = await handler(post("/api/projects/site/share", { add: ["alice@example.com"], role: "admin" }));
    const promoted = await json(admin) as { project: { permissions: { read: string[]; write: string[]; admin: string[] } } };
    expect(promoted.project.permissions).toEqual({ read: [], write: [], admin: ["alice@example.com"] });

    const read = await handler(post("/api/projects/site/share", { add: ["alice@example.com"] }));
    const demoted = await json(read) as { project: { permissions: { read: string[]; write: string[]; admin: string[] } } };
    expect(demoted.project.permissions).toEqual({ read: ["alice@example.com"], write: [], admin: [] });

    // Revoke strips every role.
    await handler(post("/api/projects/site/share", { add: ["@team.example.com"], role: "write" }));
    const revoke = await handler(post("/api/projects/site/share", { remove: ["alice@example.com", "@team.example.com"] }));
    const revoked = await json(revoke) as {
      project: { permissions: { read: string[]; write: string[]; admin: string[] } };
      warnings: string[];
    };
    expect(revoked.project.permissions).toEqual({ read: [], write: [], admin: [] });
    expect(revoked.warnings).toEqual([]);
  });

  test("writers can publish updates but nothing more; admins can share and unpublish", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const ownerHandler = await appHandler({ db, storage, auth: testAuth(user) });
    const writerHandler = await appHandler({ db, storage, auth: testAuth({ id: "user-w", email: "writer@example.com" }) });
    const adminHandler = await appHandler({ db, storage, auth: testAuth({ id: "user-a", email: "admin@example.com" }) });

    await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "v1" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));
    await ownerHandler(post("/api/projects/site/share", { add: ["writer@example.com"], role: "write" }));
    await ownerHandler(post("/api/projects/site/share", { add: ["admin@example.com"], role: "admin" }));

    // The writer can push a new revision without changing visibility.
    const republish = await writerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "v2 by writer" }),
      openPath: "/",
      project: "site",
    }));
    expect(republish.status).toBe(200);

    // Changing visibility on publish is an admin action.
    const escalate = await writerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "v3" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(escalate.status).toBe(403);
    expect(await escalate.text()).toContain("admin access");

    const writerShare = await writerHandler(post("/api/projects/site/share", { add: ["friend@example.com"] }));
    expect(writerShare.status).toBe(403);
    const writerUnpublish = await writerHandler(post("/api/projects/site/unpublish", {}));
    expect(writerUnpublish.status).toBe(403);

    // The admin can share, change visibility on publish, and unpublish — but not delete.
    const adminShare = await adminHandler(post("/api/projects/site/share", { add: ["friend@example.com"] }));
    expect(adminShare.status).toBe(200);
    const adminPublish = await adminHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "v4" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    expect(adminPublish.status).toBe(200);
    const adminUnpublish = await adminHandler(post("/api/projects/site/unpublish", {}));
    expect(adminUnpublish.status).toBe(200);
    const adminDelete = await adminHandler(new Request("https://scratch.test/api/projects/site", { method: "DELETE" }));
    expect(adminDelete.status).toBe(403);
    expect(await adminDelete.text()).toContain("owner");

    const ownerDelete = await ownerHandler(new Request("https://scratch.test/api/projects/site", { method: "DELETE" }));
    expect(ownerDelete.status).toBe(200);
  });

  test("revoking a writer works while the project is public", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    await handler(post("/api/projects/site/share", { add: ["alice@example.com"], role: "write" }));

    const revoke = await handler(post("/api/projects/site/share", { remove: ["alice@example.com"] }));
    expect(revoke.status).toBe(200);
    const body = await json(revoke) as {
      project: { visibility: string; permissions: { write: string[] } };
      warnings: string[];
    };
    expect(body.project.visibility).toBe("public");
    expect(body.project.permissions.write).toEqual([]);
    // The write role is gone, but the site is still publicly readable.
    expect(body.warnings).toEqual(["alice@example.com still has read access because the project is public"]);
  });

  test("info shows the permissions object to admins and hides it from readers", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const ownerHandler = await appHandler({ db, storage, auth: testAuth(user) });
    const readerHandler = await appHandler({ db, storage, auth: testAuth({ id: "user-r", email: "reader@example.com" }) });

    await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));
    await ownerHandler(post("/api/projects/site/share", { add: ["reader@example.com"] }));

    const ownerInfo = await json(await ownerHandler(new Request("https://scratch.test/api/projects/site"))) as {
      project: Record<string, unknown>;
    };
    expect(ownerInfo.project.visibility).toBe("private");
    expect(ownerInfo.project.permissions).toEqual({ read: ["reader@example.com"], write: [], admin: [] });

    const readerInfo = await json(await readerHandler(new Request("https://scratch.test/api/projects/site"))) as {
      project: Record<string, unknown>;
    };
    expect(readerInfo.project.visibility).toBe("private");
    expect("permissions" in readerInfo.project).toBe(false);
  });

  test("unpublish resets a project to owner-only, clearing every grant", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    await handler(post("/api/projects/site/share", { add: ["alice@example.com"] }));
    await handler(post("/api/projects/site/share", { add: ["bob@example.com"], role: "write" }));

    const unpublish = await handler(post("/api/projects/site/unpublish", {}));
    expect(unpublish.status).toBe(200);
    const body = await json(unpublish) as {
      project: { visibility: string; permissions: { read: string[]; write: string[]; admin: string[] } };
    };
    expect(body.project.visibility).toBe("private");
    expect(body.project.permissions).toEqual({ read: [], write: [], admin: [] });
  });

  test("read grants can be managed while a project is public", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "public",
    }));
    // The grant is stored alongside the public toggle, so alice keeps read access
    // when the project later goes private.
    const response = await handler(post("/api/projects/site/share", { add: ["alice@example.com"] }));
    expect(response.status).toBe(200);
    const body = await json(response) as { project: { visibility: string; permissions: { read: string[] } } };
    expect(body.project.visibility).toBe("public");
    expect(body.project.permissions.read).toEqual(["alice@example.com"]);
  });

  test("publish rejects grant-list visibilities in favor of share", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    const response = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "alice@example.com",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("scratchwork share");
  });

  test("share is owner-only and 404s for missing projects", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const ownerHandler = await appHandler({ db, storage, auth: testAuth(user) });
    const otherHandler = await appHandler({
      db,
      storage,
      auth: testAuth({ id: "user-2", email: "other@example.com" }),
    });
    await ownerHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));

    const forbidden = await otherHandler(post("/api/projects/site/share", { add: ["other@example.com"] }));
    expect(forbidden.status).toBe(403);

    const missing = await ownerHandler(post("/api/projects/no-such/share", { add: ["alice@example.com"] }));
    expect(missing.status).toBe(404);

    const unauthenticated = await appHandler({ db, storage, auth: testAuth(user, null) });
    const denied = await unauthenticated(post("/api/projects/site/share", { add: ["alice@example.com"] }));
    expect(denied.status).toBe(401);
  });

  test("share validates the request body and targets", async () => {
    const handler = await appHandler({ auth: testAuth(user) });
    await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));

    const empty = await handler(post("/api/projects/site/share", {}));
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("at least one target");

    for (const target of ["not-an-email", "public", "private"]) {
      const invalid = await handler(post("/api/projects/site/share", { add: [target] }));
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("Invalid share target");
    }
  });

  test("share enforces sharing policy on grants but never on revokes", async () => {
    const db = MemoryPrimitiveDbLive();
    const storage = new Map<string, MemoryStoredObject>();
    const openHandler = await appHandler({ db, storage, auth: testAuth(user) });
    await openHandler(post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project: "site",
      visibility: "private",
    }));
    await openHandler(post("/api/projects/site/share", { add: ["alice@old.example.com", "bob@old.example.com"] }));

    // The same server, after tightening shareAllowedDomains.
    const restricted = await appHandler({
      db,
      storage,
      auth: testAuth(user),
      config: { shareAllowedDomains: new Set(["example.com"]) },
    });
    const grant = await restricted(post("/api/projects/site/share", { add: ["carol@old.example.com"] }));
    expect(grant.status).toBe(403);
    expect(await grant.text()).toContain("shareAllowedDomains");

    // Revoking still works even though the remaining grants predate the policy.
    const revoke = await restricted(post("/api/projects/site/share", { remove: ["alice@old.example.com"] }));
    expect(revoke.status).toBe(200);
    expect(((await json(revoke)) as { project: { permissions: { read: string[] } } }).project.permissions.read)
      .toEqual(["bob@old.example.com"]);
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
          mode: "oauth",
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
      mode: "oauth",
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
      mode: "oauth",
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
          mode: "oauth",
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

describe("server homepage", () => {
  const homepageConfig = {
    appUrl: "https://app.scratch.test",
    contentUrl: "https://pages.scratch.test",
    homepageUrls: ["https://scratch.test", "https://www.scratch.test"],
    homepageProject: "www",
  } as const;

  /** Builds a request carrying its URL's host as forwarded headers: the server detects
   * home domains by request host, and web-handler requests carry no implicit Host. */
  function homeRequest(url: string, init: RequestInit = {}): Request {
    const { host } = new URL(url);
    return new Request(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        host,
        "x-forwarded-host": host,
        "x-forwarded-proto": "https",
      },
    });
  }

  test("serves the homepage project across the home origin's whole path space", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: homepageConfig });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({
        "index.html": "<h1>Welcome home</h1>",
        "docs/index.html": "<h1>Docs</h1>",
        "style.css": "body {}",
      }),
      openPath: "/",
      project: "www",
      visibility: "public",
    }));
    expect(publish.status).toBe(200);
    // The publish response reports the canonical home origin, not the content route.
    expect(((await json(publish)) as { url: string }).url).toBe("https://scratch.test/");

    const home = await handler(homeRequest("https://scratch.test/"));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Welcome home");

    const nested = await handler(homeRequest("https://scratch.test/docs/"));
    expect(nested.status).toBe(200);

    const asset = await handler(homeRequest("https://scratch.test/style.css"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/css");

    // The homepage project stays addressable at its normal content route.
    const contentRoute = await handler(new Request("https://pages.scratch.test/www/"));
    expect(contentRoute.status).toBe(200);
    expect(await contentRoute.text()).toContain("Welcome home");

    // On the home origin there is no path-based project routing.
    const otherProject = await handler(homeRequest("https://scratch.test/www/", { redirect: "manual" }));
    expect(otherProject.status).toBe(404);
  });

  test("redirects the other home domains to the canonical origin", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: homepageConfig });
    const response = await handler(homeRequest("https://www.scratch.test/docs/page?q=1", { redirect: "manual" }));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://scratch.test/docs/page?q=1");
  });

  test("answers home domains with setup instructions until the homepage is published", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: homepageConfig });
    const command = "scratchwork publish --server https://app.scratch.test --project www --visibility public";

    const plain = await handler(homeRequest("https://scratch.test/"));
    expect(plain.status).toBe(404);
    expect(await plain.text()).toContain(command);

    const page = await handler(homeRequest("https://scratch.test/", { headers: { accept: "text/html" } }));
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("scratchwork publish");
  });

  test("keeps reserved prefixes server-owned on home domains", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: homepageConfig });
    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "home", "api/index.html": "unreachable", "health": "unreachable" }),
      openPath: "/",
      project: "www",
      visibility: "public",
    }));
    expect(publish.status).toBe(200);

    const health = await handler(homeRequest("https://scratch.test/health"));
    expect(health.status).toBe(200);
    expect(await health.text()).toContain("ok");

    const api = await handler(homeRequest("https://scratch.test/api/index.html"));
    expect(api.status).toBe(404);

    const auth = await handler(homeRequest("https://scratch.test/auth/login", { redirect: "manual" }));
    expect(auth.status).toBe(302);
    expect(new URL(auth.headers.get("location") ?? "https://invalid").origin).toBe("https://app.scratch.test");
  });

  test("gates a private homepage behind the handoff flow with a /-scoped cookie", async () => {
    const authConfig = {
      mode: "oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret-session-secret-32-bytes",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    } as const;
    const token = await Effect.runPromise(createSessionToken(user, authConfig));
    const handler = await appHandler({ config: { ...homepageConfig, auth: authConfig } });

    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "private homepage", "data.json": "{}" }),
      openPath: "/",
      project: "www",
      visibility: "private",
    }, token));
    expect(publish.status).toBe(200);

    // An unauthenticated navigation bounces through the app host's project auth.
    const bounce = await handler(homeRequest("https://scratch.test/", { redirect: "manual" }));
    expect(bounce.status).toBe(302);
    const authUrl = new URL(bounce.headers.get("location") ?? "https://invalid");
    expect(authUrl.origin).toBe("https://app.scratch.test");
    expect(authUrl.pathname).toBe("/auth/project");
    expect(authUrl.searchParams.get("route")).toBe("www");
    expect(authUrl.searchParams.get("returnTo")).toBe("https://scratch.test/");

    // The app host accepts the home-origin returnTo and hands off to the home origin.
    const appRedirect = await handler(new Request(authUrl.toString(), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    }));
    expect(appRedirect.status).toBe(302);
    const handoffUrl = new URL(appRedirect.headers.get("location") ?? "https://invalid");
    expect(handoffUrl.origin).toBe("https://scratch.test");
    expect(handoffUrl.pathname).toBe("/");
    expect(handoffUrl.searchParams.get("_scratchwork_handoff")).not.toBeNull();

    // The home origin redeems the token into a cookie scoped to "/".
    const redeem = await handler(homeRequest(handoffUrl.toString(), { redirect: "manual" }));
    expect(redeem.status).toBe(302);
    expect(redeem.headers.get("location")).toBe("/");
    const setCookie = redeem.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Secure-scratchwork_access_www=");
    expect(setCookie).toContain("Path=/;");
    const cookie = setCookie.split(";")[0];

    const doc = await handler(homeRequest("https://scratch.test/", {
      headers: { cookie, "sec-fetch-dest": "document" },
    }));
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("private homepage");

    // Subresources must come from a home-origin page; same-site content-host pages are refused.
    const sameOrigin = await handler(homeRequest("https://scratch.test/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://scratch.test/" },
    }));
    expect(sameOrigin.status).toBe(200);
    const crossSite = await handler(homeRequest("https://scratch.test/data.json", {
      headers: { cookie, "sec-fetch-dest": "empty", referer: "https://pages.scratch.test/other/" },
    }));
    expect(crossSite.status).toBe(403);
  });

  test("reports the home origin as the project url in API summaries", async () => {
    const handler = await appHandler({ auth: testAuth(user), config: homepageConfig });
    const publish = await handler(post("/api/publish", {
      bundle: bundle({ "index.html": "home" }),
      openPath: "/",
      project: "www",
      visibility: "public",
    }));
    expect(publish.status).toBe(200);

    const info = await handler(new Request("https://app.scratch.test/api/projects/www"));
    expect(info.status).toBe(200);
    expect(((await json(info)) as { project: { url: string } }).project.url).toBe("https://scratch.test/");
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
