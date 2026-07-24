/*
 * The API policy matrix (AGENTS.md, invariant 4), generated from the same
 * registry the dispatcher runs: for every registered route × credential kind
 * (none, garbage bearer, and real bearers for a stranger, reader, writer,
 * admin, and owner) × project visibility (private, public), the expected
 * outcome is DERIVED from the route's declared policy — auth mode, minimum
 * role, masking — and every combination the policy does not explicitly allow
 * must be denied. Adding a route to API_ROUTES without policy metadata is a
 * type error; adding one without a fixture here fails the completeness check.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { API_ROUTES, type ApiRoute } from "../src/api-routes";
import { createMcpAccessToken, createSessionToken, type AuthUser } from "../src/auth";
import type { AuthConfig } from "../src/config";
import { MCP_OAUTH_ROUTES } from "../src/mcp-oauth-routes";
import { roleAtLeast, type ProjectRole } from "../src/site-store";
import { appHandler, bundle, json } from "./helpers";

/** Must match the appHandler defaults in helpers.ts so minted bearers verify. */
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
  stranger: { id: "stranger-1", email: "stranger@example.com" },
} satisfies Record<string, AuthUser>;

/** The credential kinds the matrix sweeps. `role` is the granted role on the
 * private fixture project; effective role on the public project floors at read. */
const CREDENTIALS: ReadonlyArray<{ name: string; user: AuthUser | null; garbage?: boolean; role: ProjectRole }> = [
  { name: "no credential", user: null, role: "none" },
  { name: "garbage bearer", user: null, garbage: true, role: "none" },
  { name: "stranger", user: users.stranger, role: "none" },
  { name: "reader", user: users.reader, role: "read" },
  { name: "writer", user: users.writer, role: "write" },
  { name: "admin", user: users.admin, role: "admin" },
  { name: "owner", user: users.owner, role: "owner" },
];

/** Builds a success-shaped request for each route; the matrix swaps credentials in. */
const FIXTURES: Record<string, (project: string) => { path: string; method: string; body?: unknown }> = {
  health: () => ({ path: "/health", method: "GET" }),
  me: () => ({ path: "/api/me", method: "GET" }),
  "cli-token-exchange": () => ({
    path: "/auth/cli/token",
    method: "POST",
    body: { code: "not-a-real-code", codeVerifier: "v".repeat(43), redirectUri: "http://127.0.0.1:1/cb" },
  }),
  publish: (project) => ({
    path: "/api/publish",
    method: "POST",
    body: { bundle: bundle({ "index.html": "update" }), openPath: "/", project },
  }),
  "projects-list": () => ({ path: "/api/projects", method: "GET" }),
  resolve: (project) => ({ path: `/api/resolve?path=/${project}/`, method: "GET" }),
  "project-info": (project) => ({ path: `/api/projects/${project}`, method: "GET" }),
  "project-bundle": (project) => ({ path: `/api/projects/${project}/bundle`, method: "GET" }),
  "project-unpublish": (project) => ({ path: `/api/projects/${project}/unpublish`, method: "POST", body: {} }),
  "project-share": (project) => ({
    path: `/api/projects/${project}/share`,
    method: "POST",
    body: { role: "read", add: ["friend@example.com"] },
  }),
  "project-delete": (project) => ({ path: `/api/projects/${project}`, method: "DELETE" }),
};

/** Mints a real bearer for a user with the fixture auth config. */
async function bearer(user: AuthUser): Promise<string> {
  return Effect.runPromise(createSessionToken(user, authConfig));
}

/** A fresh server with one private and one public project and the standard
 * grants. Rebuilt per mutating cell so no cell poisons another. */
async function fixture() {
  const handler = await appHandler({});
  const ownerToken = await bearer(users.owner);
  const post = (path: string, body: unknown) =>
    handler(new Request(`https://scratch.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  for (const [project, isPublic] of [["site", false], ["pub", true]] as const) {
    const published = await post("/api/publish", {
      bundle: bundle({ "index.html": "hello" }),
      openPath: "/",
      project,
      isPublic,
    });
    if (published.status !== 200) throw new Error(`fixture publish failed: ${await published.text()}`);
    for (const [role, user] of [["read", users.reader], ["write", users.writer], ["admin", users.admin]] as const) {
      const shared = await post(`/api/projects/${project}/share`, { role, add: [user.email] });
      if (shared.status !== 200) throw new Error(`fixture share failed: ${await shared.text()}`);
    }
  }
  return handler;
}

/** Runs one matrix cell: the route's fixture request with one credential. */
async function callRoute(
  handler: Awaited<ReturnType<typeof fixture>>,
  route: ApiRoute,
  credential: (typeof CREDENTIALS)[number],
  project: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const shape = FIXTURES[route.name];
  if (shape == null) throw new Error(`no request fixture for route "${route.name}" — add one to FIXTURES`);
  const { path, method, body } = shape(project);
  const allHeaders: Record<string, string> = { ...headers };
  if (credential.garbage) allHeaders.authorization = "Bearer garbage.token";
  else if (credential.user != null) allHeaders.authorization = `Bearer ${await bearer(credential.user)}`;
  if (body !== undefined) allHeaders["content-type"] = "application/json";
  return handler(new Request(`https://scratch.test${path}`, {
    method,
    headers: allHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

/** The role a credential holds on a fixture project (public floors at read). */
function effectiveRole(credential: (typeof CREDENTIALS)[number], isPublic: boolean): ProjectRole {
  if (isPublic && !roleAtLeast(credential.role, "read")) return "read";
  return credential.role;
}

describe("api route policy matrix", () => {
  test("every registered route has a request fixture, and no fixture is stale", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(API_ROUTES.map((route) => route.name).sort());
    expect(new Set(API_ROUTES.map((r) => r.name)).size).toBe(API_ROUTES.length);
    expect(new Set(API_ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(API_ROUTES.length);
  });

  for (const route of API_ROUTES.filter((candidate) => candidate.auth !== "code-exchange")) {
    for (const subject of [{ project: "site", isPublic: false }, { project: "pub", isPublic: true }] as const) {
      test(`${route.name} on ${subject.isPublic ? "public" : "private"} project denies every unauthorized credential`, async () => {
        // Read-only cells share one server; mutating cells get a fresh one.
        const shared = route.mutation ? null : await fixture();
        for (const credential of CREDENTIALS) {
          const handler = shared ?? await fixture();
          const response = await callRoute(handler, route, credential, subject.project);
          const label = `${route.name} × ${credential.name} × ${subject.project}`;
          const outcome = { label, status: response.status };

          if (route.auth === "bearer" && credential.user == null) {
            expect(outcome).toEqual({ label, status: 401 });
            continue;
          }
          if (route.auth === "optional" || route.minimumRole == null) {
            expect(outcome).toEqual({ label, status: 200 });
            continue;
          }
          const role = effectiveRole(credential, subject.isPublic);
          if (roleAtLeast(role, route.minimumRole)) {
            expect(outcome).toEqual({ label, status: 200 });
          } else if (!roleAtLeast(role, "read")) {
            // Below read, the project's very existence is masked. Project
            // routes answer "Project not found"; publish answers with the
            // name-collision message a genuinely taken name would get.
            const text = await response.text();
            if (route.name === "publish") {
              expect({ label, status: response.status, masked: text.includes("already taken") })
                .toEqual({ label, status: 409, masked: true });
            } else {
              expect([403, 404]).toContain(response.status);
              expect({ label, masked: text.includes("Project not found") }).toEqual({ label, masked: true });
            }
          } else {
            // Readable but below the declared minimum: denied, never a mask
            // bypass, never a success.
            expect([403, 409]).toContain(response.status);
          }
        }
      }, 30_000);
    }
  }

  test("every route rejects cross-origin browser calls", async () => {
    const handler = await fixture();
    for (const route of API_ROUTES) {
      const credential = CREDENTIALS[6]; // owner: the strongest credential must still be rejected
      const response = await callRoute(handler, route, credential, "site", { origin: "https://evil.example" });
      expect({ route: route.name, status: response.status }).toEqual({ route: route.name, status: 403 });
      const fetchSite = await callRoute(handler, route, credential, "site", { "sec-fetch-site": "cross-site" });
      expect({ route: route.name, status: fetchSite.status }).toEqual({ route: route.name, status: 403 });
    }
  });

  test("unregistered methods on registered paths are 405, unknown API paths are 404", async () => {
    const handler = await fixture();
    for (const path of new Set(API_ROUTES.map((route) => FIXTURES[route.name]!("site").path.split("?")[0]))) {
      const response = await handler(new Request(`https://scratch.test${path}`, { method: "PUT" }));
      expect({ path, status: response.status }).toEqual({ path, status: 405 });
    }
    for (const path of ["/api/definitely-not-a-route", "/api/projects/site/evil", "/api/projects/site/bundle/extra"]) {
      const response = await handler(new Request(`https://scratch.test${path}`));
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });

  test("the code-exchange route needs no ambient credential and never mints from garbage", async () => {
    const handler = await fixture();
    const route = API_ROUTES.find((candidate) => candidate.auth === "code-exchange")!;
    // No session, garbage code: the failure is the code's, not a 401 demand
    // for a bearer — the one-time code is the credential.
    const response = await callRoute(handler, route, CREDENTIALS[0], "site");
    expect(response.status).toBe(400);
    const empty = await handler(new Request("https://scratch.test/auth/cli/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }));
    expect(empty.status).toBe(400);
  });

  test("an mcp-access bearer never authenticates on the JSON API (audience confusion)", async () => {
    // The MCP access token authorizes only the /mcp endpoint. Presented to any
    // JSON API route it must read as no credential at all: bearer routes 401,
    // optional routes answer anonymously. This is the deny-all matrix row for
    // the credential kind introduced by the MCP OAuth surface.
    const handler = await fixture();
    const token = await Effect.runPromise(createMcpAccessToken(
      { user: users.owner, clientId: "matrix-client-1" },
      "https://scratch.test/mcp",
      authConfig,
    ));
    for (const route of API_ROUTES.filter((candidate) => candidate.auth !== "code-exchange")) {
      const { path, method, body } = FIXTURES[route.name]!("site");
      const response = await handler(new Request(`https://scratch.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const label = `${route.name} × mcp-access bearer`;
      if (route.auth === "bearer") {
        expect({ label, status: response.status }).toEqual({ label, status: 401 });
      } else if (route.name === "me") {
        expect({ label, body: await json(response) }).toEqual({ label, body: { authenticated: false, user: null } });
      } else {
        expect({ label, status: response.status }).toEqual({ label, status: 200 });
      }
    }
  });

  test("every MCP OAuth route is dispatched at its declared method, and only there", async () => {
    // The MCP OAuth surface keeps its own registry (it is server-only, outside
    // the shared contract); this is its completeness check — a dispatched path
    // missing from MCP_OAUTH_ROUTES, or a registry row nothing dispatches,
    // fails here. Behavior per endpoint is covered in mcp-oauth.test.ts.
    const handler = await fixture();
    for (const route of MCP_OAUTH_ROUTES) {
      const declared = await handler(new Request(`https://scratch.test${route.path}`, {
        method: route.method,
        ...(route.method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      }));
      // Dispatched: anything but the not-found/method-not-allowed fallthroughs.
      expect({ route: route.name, dispatched: declared.status }).not.toEqual({ route: route.name, dispatched: 404 });
      expect({ route: route.name, dispatched: declared.status }).not.toEqual({ route: route.name, dispatched: 405 });
      const wrongMethod = await handler(new Request(`https://scratch.test${route.path}`, {
        method: route.method === "GET" ? "POST" : "GET",
      }));
      expect({ route: route.name, status: wrongMethod.status }).toEqual({ route: route.name, status: 405 });
    }
  });

  test("MCP OAuth cross-origin policy follows each route's credential model", async () => {
    const handler = await fixture();
    // Consent reads the session cookie, so it must reject cross-origin like
    // every API route. The credential-free endpoints are deliberately
    // CORS-open (they never read an ambient credential), and that must stay
    // visible as an explicit ACAO header, not an accident.
    const sessionUser = await bearer(users.owner);
    const consent = await handler(new Request("https://scratch.test/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${sessionUser}`,
        origin: "https://evil.example",
      },
      body: "txn=x&decision=approve",
    }));
    expect(consent.status).toBe(403);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const response = await handler(new Request(`https://scratch.test${path}`));
      expect({ path, acao: response.headers.get("access-control-allow-origin") }).toEqual({ path, acao: "*" });
    }
  });

  test("permissions are visible only to admin+ callers (declared visibility)", async () => {
    const handler = await fixture();
    const info = async (credential: (typeof CREDENTIALS)[number]) => {
      const route = API_ROUTES.find((candidate) => candidate.name === "project-info")!;
      const response = await callRoute(handler, route, credential, "site");
      expect(response.status).toBe(200);
      return (await response.json() as { project: Record<string, unknown> }).project;
    };
    expect((await info(CREDENTIALS[3])).permissions).toBeUndefined(); // reader
    expect((await info(CREDENTIALS[4])).permissions).toBeUndefined(); // writer
    expect((await info(CREDENTIALS[5])).permissions).toBeDefined(); // admin
    expect((await info(CREDENTIALS[6])).permissions).toBeDefined(); // owner
  });
});
