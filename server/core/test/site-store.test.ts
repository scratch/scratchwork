import { describe, expect, test } from "bun:test";
import type { ServerConfigShape } from "../src/config";
import { canReadProject, candidateRoutePaths, routeRest, type SiteRecord } from "../src/site-store";

const owner = { id: "user-1", email: "founder@example.com" };
const reader = { id: "user-2", email: "reader@example.com" };

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

function config(maxVisibility: string): ServerConfigShape {
  return {
    port: 3001,
    maxVisibility,
    shareAllowedDomains: new Set(),
    projectPath: "workspace/project",
    defaultWorkspace: "personal",
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

describe("candidateRoutePaths", () => {
  test("returns longest-first prefixes of decoded segments", () => {
    expect(candidateRoutePaths("/demo/site/app.js")).toEqual(["demo/site/app.js", "demo/site", "demo"]);
  });

  test("rejects encoded slashes that would fabricate multi-segment routes", () => {
    expect(candidateRoutePaths("/demo%2Fsite")).toEqual([]);
    expect(candidateRoutePaths("/demo%2Fsite/extra")).toEqual([]);
  });

  test("decodes benign percent-encoding within a segment", () => {
    expect(candidateRoutePaths("/pete%2Dx/app.js")).toEqual(["pete-x/app.js", "pete-x"]);
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
