import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServerConfigShape } from "../src/config";
import { PrimitiveDb, makeMemoryPrimitiveDb, type PrimitiveDbShape } from "../src/db";
import type { PublishRequest } from "../src/publish-request";
import { projectForRequest, routeRest } from "../src/routes";
import * as Schema from "effect/Schema";
import { SiteRecordSchema, type SiteRecord } from "../src/site-records";
import { SiteStore, SiteStoreLive, SiteStoreError, canReadProject, migrateSiteRecord, projectRole } from "../src/site-store";
import { bundle, memoryStorageLayer } from "./helpers";

const owner = { id: "user-1", email: "founder@example.com" };
const reader = { id: "user-2", email: "reader@example.com" };

/** Builds a SiteRecord fixture with the given visibility and optional grant groups. */
function record(visibility: string, groups: { readers?: string; writers?: string; admins?: string } = {}): SiteRecord {
  return {
    version: 4,
    project: "site",
    visibility,
    readers: groups.readers ?? "private",
    writers: groups.writers ?? "private",
    admins: groups.admins ?? "private",
    owner,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    currentRevisionId: "rev-1",
    currentOpenPath: "/",
    fileCount: 1,
    totalBytes: 10,
  };
}

/** Builds a ServerConfigShape fixture with the given visibility ceiling. */
function config(maxVisibility: string): ServerConfigShape {
  return {
    port: 3001,
    homepageUrls: [],
    maxVisibility,
    shareAllowedDomains: new Set(),
    usersCanSetProjectNames: true,
    defaultVisibility: "private",
    auth: {
      mode: "oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "test-session-secret-test-session-secret",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    },
  };
}

/** Builds a publish request fixture for one project name. */
function request(project: string | undefined): PublishRequest {
  return {
    bundle: bundle({ "index.html": "hello" }),
    openPath: "/",
    project,
    visibility: "public",
    totalBytes: 5,
  } as PublishRequest;
}

/** Runs one effect against a fresh site store over the given DB shape. */
function run<A, E>(
  db: PrimitiveDbShape,
  body: (store: typeof SiteStore.Service) => Effect.Effect<A, E, SiteStore>,
): Promise<A> {
  const layers = Layer.provideMerge(
    SiteStoreLive,
    Layer.mergeAll(memoryStorageLayer(), Layer.succeed(PrimitiveDb, PrimitiveDb.of(db))),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SiteStore;
      return yield* body(store);
    }).pipe(Effect.provide(layers)),
  );
}

describe("canReadProject", () => {
  test("owner can read their project when maxVisibility tightens below stored visibility", () => {
    expect(canReadProject(record("public"), owner, config("@example.com"))).toBe(true);
  });

  test("non-owner readers are still gated by the maxVisibility ceiling", () => {
    expect(canReadProject(record("public"), reader, config("@example.com"))).toBe(false);
    expect(canReadProject(record("public"), null, config("@example.com"))).toBe(false);
  });

  test("matching readers can read within the ceiling", () => {
    expect(canReadProject(record("public"), reader, config("public"))).toBe(true);
    expect(canReadProject(record("public"), null, config("public"))).toBe(true);
    expect(canReadProject(record("private"), reader, config("public"))).toBe(false);
  });
});

describe("projectRole", () => {
  test("grades owner, admin, write, read, and none", () => {
    const shared = record("private", { readers: "reader@example.com", writers: "writer@example.com", admins: "admin@example.com" });
    const serverConfig = config("public");
    expect(projectRole(shared, owner, serverConfig)).toBe("owner");
    expect(projectRole(shared, { id: "u-a", email: "admin@example.com" }, serverConfig)).toBe("admin");
    expect(projectRole(shared, { id: "u-w", email: "writer@example.com" }, serverConfig)).toBe("write");
    expect(projectRole(shared, reader, serverConfig)).toBe("read");
    expect(projectRole(shared, { id: "u-x", email: "stranger@example.com" }, serverConfig)).toBe("none");
    expect(projectRole(shared, null, serverConfig)).toBe("none");
  });

  test("public visibility confers read on everyone, including anonymous viewers", () => {
    const open = record("public");
    expect(projectRole(open, reader, config("public"))).toBe("read");
    expect(projectRole(open, null, config("public"))).toBe("read");
  });

  test("domain grants confer write and admin", () => {
    const shared = record("private", { writers: "@team.example.com", admins: "@ops.example.com" });
    expect(projectRole(shared, { id: "u-1", email: "dev@team.example.com" }, config("public"))).toBe("write");
    expect(projectRole(shared, { id: "u-2", email: "sre@ops.example.com" }, config("public"))).toBe("admin");
  });

  test("the maxVisibility ceiling gates every granted role, never the owner", () => {
    const shared = record("public", { writers: "writer@example.com", admins: "admin@example.com" });
    const tightened = config("@allowed.example.com");
    expect(projectRole(shared, owner, tightened)).toBe("owner");
    expect(projectRole(shared, { id: "u-a", email: "admin@example.com" }, tightened)).toBe("none");
    expect(projectRole(shared, { id: "u-w", email: "writer@example.com" }, tightened)).toBe("none");
    expect(projectRole(shared, reader, tightened)).toBe("none");
  });
});

describe("legacy record migration", () => {
  test("records written before roles decode with private grant groups", () => {
    const decoded = Schema.decodeUnknownSync(SiteRecordSchema)({
      version: 4,
      project: "site",
      visibility: "public",
      owner,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      currentRevisionId: "rev-1",
      currentOpenPath: "/",
      fileCount: 1,
      totalBytes: 10,
    });
    expect(decoded.readers).toBe("private");
    expect(decoded.writers).toBe("private");
    expect(decoded.admins).toBe("private");
  });

  test("a legacy group visibility migrates into the readers grant list", () => {
    const legacy = migrateSiteRecord(record("alice@example.com,@example.com"));
    expect(legacy.visibility).toBe("private");
    expect(legacy.readers).toBe("alice@example.com,@example.com");
    // Binary visibilities pass through untouched.
    expect(migrateSiteRecord(record("public"))).toEqual(record("public"));
    expect(migrateSiteRecord(record("private"))).toEqual(record("private"));
  });
});

describe("project name claims", () => {
  test("maps a lost create race onto the canonical taken message", async () => {
    // Simulate a race: the name is free at load time, but another create lands first —
    // the memory DB below reports the record as missing on first read, then delegates.
    const memory = makeMemoryPrimitiveDb();
    let hideOnce = true;
    const db: PrimitiveDbShape = {
      ...memory,
      get: (namespace, key) => {
        if (namespace === "projects" && key === "site" && hideOnce) {
          hideOnce = false;
          return Effect.succeed(null);
        }
        return memory.get(namespace, key);
      },
    };

    await run(db, (store) => store.publish(request("site"), owner, config("public")));
    const failed = await run(db, (store) =>
      store.publish(request("site"), reader, config("public")).pipe(Effect.flip),
    ) as SiteStoreError;

    expect(failed.status).toBe(409);
    expect(failed.message).toBe(
      'Project name "site" is already taken on this server. Choose another with --project.',
    );
  });

  test("owner updates in place; another owner gets the canonical 409", async () => {
    const db = makeMemoryPrimitiveDb();

    const created = await run(db, (store) => store.publish(request("site"), owner, config("public")));
    expect(created.project).toBe("site");

    const updated = await run(db, (store) => store.publish(request("site"), owner, config("public")));
    expect(updated.project).toBe("site");

    const denied = await run(db, (store) =>
      store.publish(request("site"), reader, config("public")).pipe(Effect.flip),
    ) as SiteStoreError;
    expect(denied.status).toBe(409);
    expect(denied.message).toContain("already taken");
  });

  test("random naming mints a slug, republishes by slug, and retries collisions", async () => {
    const db = makeMemoryPrimitiveDb();
    const randomConfig = { ...config("public"), usersCanSetProjectNames: false };

    const created = await run(db, (store) => store.publish(request(undefined), owner, randomConfig));
    expect(created.project).toMatch(/^[a-z2-9]{10}$/);

    // Resending the returned slug updates the same project.
    const updated = await run(db, (store) => store.publish(request(created.project), owner, randomConfig));
    expect(updated.project).toBe(created.project);

    // A nonexistent sent name is discarded and a fresh slug minted.
    const fresh = await run(db, (store) => store.publish(request("my-notes"), owner, randomConfig));
    expect(fresh.project).toMatch(/^[a-z2-9]{10}$/);
    expect(fresh.project).not.toBe("my-notes");

    // Someone else's existing slug is a 409, not a silent fork.
    const denied = await run(db, (store) =>
      store.publish(request(created.project), reader, randomConfig).pipe(Effect.flip),
    ) as SiteStoreError;
    expect(denied.status).toBe(409);
  });

  test("garbage project names load as missing, not as backend keys", async () => {
    const db = makeMemoryPrimitiveDb();
    for (const project of ["", "..", ".", "a/b", "_x"]) {
      const loaded = await run(db, (store) => store.loadProject(project));
      expect(loaded).toBeNull();
    }
  });
});

describe("projectForRequest", () => {
  test("takes exactly the first path segment", () => {
    expect(projectForRequest("/site/app.js")).toBe("site");
    expect(projectForRequest("/site")).toBe("site");
    expect(projectForRequest("/site/a/b/c")).toBe("site");
  });

  test("returns null for the root path", () => {
    expect(projectForRequest("/")).toBeNull();
  });

  test("rejects encoded slashes that would fabricate paths inside a project", () => {
    expect(projectForRequest("/si%2Fte")).toBeNull();
    expect(projectForRequest("/si%2Fte/a/b")).toBeNull();
  });

  test("decodes benign percent-encoding within the segment", () => {
    expect(projectForRequest("/pete%2Dx/app.js")).toBe("pete-x");
  });

  test("rejects segments that are not safe project identifiers", () => {
    expect(projectForRequest("/..")).toBeNull();
    expect(projectForRequest("/%2E%2E")).toBeNull();
    expect(projectForRequest("/Docs/index.html")).toBeNull();
    expect(projectForRequest("/%zz")).toBeNull();
  });
});

describe("routeRest", () => {
  test("computes the remainder for plain paths", () => {
    expect(routeRest("/site", "site")).toBeNull();
    expect(routeRest("/site/", "site")).toBe("/");
    expect(routeRest("/site/a/b.js", "site")).toBe("/a/b.js");
    expect(routeRest("/site/a/", "site")).toBe("/a/");
  });

  test("matches encoded route segments in decoded space", () => {
    expect(routeRest("/pete%2Dx/app.js", "pete-x")).toBe("/app.js");
    expect(routeRest("/si%74e/style.css", "site")).toBe("/style.css");
  });

  test("never serves a remainder for paths the project does not prefix", () => {
    expect(routeRest("/si%2Fte", "site")).toBeNull();
    expect(routeRest("/other/a.js", "site")).toBeNull();
  });
});
