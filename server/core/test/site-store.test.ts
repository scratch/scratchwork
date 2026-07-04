import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServerConfigShape } from "../src/config";
import { PrimitiveDb, PrimitiveDbError, makeMemoryPrimitiveDb, type PrimitiveDbShape } from "../src/db";
import type { PublishRequest } from "../src/publish-request";
import { routePathForRequest, routeRest } from "../src/routes";
import type { SiteRecord } from "../src/site-records";
import { SiteStore, SiteStoreLive, canReadProject } from "../src/site-store";
import { bundle, memoryStorageLayer } from "./helpers";

const owner = { id: "user-1", email: "founder@example.com" };
const reader = { id: "user-2", email: "reader@example.com" };

/** Builds a SiteRecord fixture with the given visibility. */
function record(visibility: string): SiteRecord {
  return {
    version: 3,
    workspace: "demo",
    project: "site",
    routePath: "demo/site",
    visibility,
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
    maxVisibility,
    shareAllowedDomains: new Set(),
    projectRoutingMode: "workspace/project",
    defaultWorkspace: "username",
    usersCanCreateWorkspaces: true,
    defaultVisibility: "private",
    auth: {
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "test-session-secret-test-session-secret",
      allowedUsers: "public",
      sessionTtlSeconds: 60,
    },
  };
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

describe("publish route allocation", () => {
  test("releases the route when the project record write fails", async () => {
    const memory = makeMemoryPrimitiveDb();
    let failProjectWrite = true;
    const db: PrimitiveDbShape = {
      ...memory,
      put: (namespace, key, value, options) => {
        if (namespace === "projects" && failProjectWrite) {
          failProjectWrite = false;
          return Effect.fail(new PrimitiveDbError({ message: "injected write failure" }));
        }
        return memory.put(namespace, key, value, options);
      },
    };
    const layers = Layer.provideMerge(
      SiteStoreLive,
      Layer.mergeAll(memoryStorageLayer(), Layer.succeed(PrimitiveDb, PrimitiveDb.of(db))),
    );
    const request = {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      workspace: "demo",
      project: "site",
      visibility: "public",
      totalBytes: 5,
    } as PublishRequest;

    const { failed, retried } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SiteStore;
        const failed = yield* store.publish(request, owner, config("public")).pipe(Effect.flip);
        const retried = yield* store.publish(request, owner, config("public"));
        return { failed, retried };
      }).pipe(Effect.provide(layers)),
    );

    expect(failed.message).toContain("injected write failure");
    expect(retried.routePath).toBe("demo/site");
  });
});

describe("routePathForRequest", () => {
  test("takes exactly routeDepth segments for the configured mode", () => {
    expect(routePathForRequest("/demo/site/app.js", "workspace/project")).toBe("demo/site");
    expect(routePathForRequest("/demo/site", "workspace/project")).toBe("demo/site");
    expect(routePathForRequest("/example.com/demo/site/app.js", "userDomain/workspace/project")).toBe("example.com/demo/site");
  });

  test("returns null for paths shallower than the route depth", () => {
    expect(routePathForRequest("/", "workspace/project")).toBeNull();
    expect(routePathForRequest("/demo", "workspace/project")).toBeNull();
    expect(routePathForRequest("/demo/site", "userDomain/workspace/project")).toBeNull();
  });

  test("rejects encoded slashes that would fabricate multi-segment routes", () => {
    expect(routePathForRequest("/demo%2Fsite/extra", "workspace/project")).toBeNull();
    expect(routePathForRequest("/demo%2Fsite/a/b", "workspace/project")).toBeNull();
  });

  test("decodes benign percent-encoding within a segment", () => {
    expect(routePathForRequest("/pete%2Dx/site/app.js", "workspace/project")).toBe("pete-x/site");
  });
});

describe("routeRest", () => {
  test("computes the remainder for plain paths", () => {
    expect(routeRest("/demo/site", "demo/site")).toBeNull();
    expect(routeRest("/demo/site/", "demo/site")).toBe("/");
    expect(routeRest("/demo/site/a/b.js", "demo/site")).toBe("/a/b.js");
    expect(routeRest("/demo/site/a/", "demo/site")).toBe("/a/");
  });

  test("matches encoded route segments in decoded space", () => {
    expect(routeRest("/pete%2Dx/app.js", "pete-x")).toBe("/app.js");
    expect(routeRest("/de%6Do/site/style.css", "demo/site")).toBe("/style.css");
  });

  test("never serves a remainder for paths the route does not prefix", () => {
    expect(routeRest("/demo%2Fsite", "demo/site")).toBeNull();
    expect(routeRest("/other/site/a.js", "demo/site")).toBeNull();
  });
});
