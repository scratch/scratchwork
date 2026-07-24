/*
 * Tests of the /mcp endpoint: JSON-RPC framing, protocol-version negotiation,
 * statelessness, per-tool round trips through real publishes, and the
 * policy-parity matrix — every tool derives its expected outcome from the
 * API_POLICY entry of its backing endpoint, so the MCP surface provably
 * enforces the same authorization the HTTP routes do (invariant 4). The OAuth
 * flow that mints mcp-access tokens is covered in mcp-oauth.test.ts; here
 * bearers are minted directly.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { API_ROUTES } from "../src/api-routes";
import { createMcpAccessToken, createSessionToken, type AuthUser } from "../src/auth";
import type { AuthConfig } from "../src/config";
import { MCP_TOOLS } from "../src/mcp/tools";
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

const BASE = "https://scratch.test";
const AUD = `${BASE}/mcp`;

const users = {
  owner: { id: "owner-1", email: "owner@example.com" },
  admin: { id: "admin-1", email: "admin@example.com" },
  writer: { id: "writer-1", email: "writer@example.com" },
  reader: { id: "reader-1", email: "reader@example.com" },
  stranger: { id: "stranger-1", email: "stranger@example.com" },
} satisfies Record<string, AuthUser>;

type Handler = Awaited<ReturnType<typeof appHandler>>;

/** Mints the MCP access token the OAuth flow would issue this user. */
async function mcpBearer(user: AuthUser): Promise<string> {
  return Effect.runPromise(createMcpAccessToken({ user, clientId: "mcp-test-client" }, AUD, authConfig));
}

/** One JSON-RPC POST to /mcp. */
async function rpc(
  handler: Handler,
  body: unknown,
  options: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return handler(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token == null ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** Calls one tool and returns the JSON-RPC response body. */
async function callTool(
  handler: Handler,
  token: string,
  name: string,
  args: unknown,
): Promise<{ result?: { content?: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean }; error?: { code: number; message: string } }> {
  const response = await rpc(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, { token });
  expect(response.status).toBe(200);
  return await json(response) as never;
}

/** A server with one private and one public project plus the standard grants. */
async function fixture(): Promise<Handler> {
  const handler = await appHandler({});
  const token = await mcpBearer(users.owner);
  for (const [project, isPublic] of [["site", false], ["pub", true]] as const) {
    const published = await callTool(handler, token, "publish", {
      files: [{ path: "index.html", content: `<h1>${project}</h1>` }],
      project,
      isPublic,
    });
    if (published.result?.isError) throw new Error(`fixture publish failed: ${JSON.stringify(published)}`);
    for (const [role, user] of [["read", users.reader], ["write", users.writer], ["admin", users.admin]] as const) {
      const shared = await callTool(handler, token, "share_project", { project, role, add: [user.email] });
      if (shared.result?.isError) throw new Error(`fixture share failed: ${JSON.stringify(shared)}`);
    }
  }
  return handler;
}

describe("mcp transport: framing and negotiation", () => {
  test("initialize negotiates both supported revisions and never issues a session id", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    for (const requested of ["2025-06-18", "2025-03-26"]) {
      const response = await rpc(handler, {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }, { token });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      const body = await json(response) as { result: { protocolVersion: string; serverInfo: { name: string } } };
      expect(body.result.protocolVersion).toBe(requested);
      expect(body.result.serverInfo.name).toBe("scratchwork");
    }
    // An unknown requested version answers with the latest supported one.
    const unknown = await rpc(handler, {
      jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "1999-01-01" },
    }, { token });
    expect(((await json(unknown)) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/call works without a prior initialize — the transport is stateless", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const body = await callTool(handler, token, "whoami", {});
    expect(body.result?.structuredContent).toEqual({ authenticated: true, user: users.owner });
  });

  test("an unsupported MCP-Protocol-Version header is a 400; absent is accepted", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const bad = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      token,
      headers: { "mcp-protocol-version": "2024-01-01" },
    });
    expect(bad.status).toBe(400);
    const good = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      token,
      headers: { "mcp-protocol-version": "2025-03-26" },
    });
    expect(good.status).toBe(200);
  });

  test("framing errors map to the JSON-RPC error codes", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const cases: Array<{ body: unknown; code: number }> = [
      { body: "not json", code: -32700 },
      { body: [{ jsonrpc: "2.0", id: 1, method: "ping" }], code: -32600 },
      { body: { jsonrpc: "1.0", id: 1, method: "ping" }, code: -32600 },
      { body: { jsonrpc: "2.0", id: 1 }, code: -32600 },
      { body: { jsonrpc: "2.0", id: 1, method: "resources/list" }, code: -32601 },
      { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, code: -32602 },
      { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no-such-tool" } }, code: -32602 },
    ];
    for (const item of cases) {
      const response = await rpc(handler, item.body, { token });
      const body = await json(response) as { error?: { code: number } };
      expect({ case: item.body, code: body.error?.code }).toEqual({ case: item.body, code: item.code });
    }
  });

  test("notifications are acknowledged with an empty 202", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const response = await rpc(handler, { jsonrpc: "2.0", method: "notifications/initialized" }, { token });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("non-POST methods are 405", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await handler(new Request(`${BASE}/mcp`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }));
      expect({ method, status: response.status }).toEqual({ method, status: 405 });
    }
  });

  test("unauthenticated requests get the 401 that starts the OAuth flow", async () => {
    const handler = await appHandler({});
    const credentialCases: Array<Record<string, string>> = [{}, { authorization: "Bearer garbage.token" }];
    for (const headers of credentialCases) {
      const response = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "initialize" }, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
      );
    }
  });

  test("a session bearer is accepted; a wrong-audience mcp token is not", async () => {
    const handler = await appHandler({});
    const session = await Effect.runPromise(createSessionToken(users.owner, authConfig));
    const viaSession = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: session });
    expect(viaSession.status).toBe(200);
    const foreign = await Effect.runPromise(
      createMcpAccessToken({ user: users.owner, clientId: "c" }, "https://other.example/mcp", authConfig),
    );
    const viaForeign = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, { token: foreign });
    expect(viaForeign.status).toBe(401);
  });

  test("cross-origin browser calls are rejected even with a valid bearer", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const originCases: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of originCases) {
      const response = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, { token, headers });
      expect(response.status).toBe(403);
    }
  });

  test("oversized bodies stay an HTTP 413, not a JSON-RPC parse error", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const response = await rpc(handler, `{"pad":"${"x".repeat(35 * 1024 * 1024)}"}`, { token });
    expect(response.status).toBe(413);
  });

  test("tools/list advertises every registered tool with derived object schemas", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const response = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token });
    const body = await json(response) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string; $schema?: string } }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    for (const tool of body.result.tools) {
      expect({ name: tool.name, type: tool.inputSchema.type }).toEqual({ name: tool.name, type: "object" });
      expect(tool.inputSchema.$schema).toBeUndefined();
    }
  });
});

describe("mcp tools: round trips", () => {
  test("publish serves mixed text and binary files at the returned URL", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const published = await callTool(handler, token, "publish", {
      files: [
        { path: "index.html", content: "<h1>hello mcp</h1>" },
        { path: "img/dot.png", contentBase64: binary.toString("base64") },
      ],
      project: "mcp-pub",
      isPublic: true,
      openPath: "/",
    });
    expect(published.result?.isError).toBeUndefined();
    const structured = published.result?.structuredContent as { project: string; url: string; isPublic: boolean };
    expect(structured.project).toBe("mcp-pub");
    expect(structured.isPublic).toBe(true);
    // The text mirror carries the same JSON for clients that ignore structuredContent.
    expect(JSON.parse(published.result?.content?.[0]?.text ?? "")).toEqual(structured);

    const page = await handler(new Request(`${BASE}/mcp-pub/`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("hello mcp");
    const image = await handler(new Request(`${BASE}/mcp-pub/img/dot.png`));
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(binary));
  });

  test("list, info, share, unpublish, delete, whoami round-trip", async () => {
    const handler = await fixture();
    const token = await mcpBearer(users.owner);

    const listed = await callTool(handler, token, "list_projects", {});
    const projects = (listed.result?.structuredContent as { projects: Array<{ project: string }> }).projects;
    expect(projects.map((p) => p.project).sort()).toEqual(["pub", "site"]);

    const info = await callTool(handler, token, "project_info", { project: "site" });
    const summary = (info.result?.structuredContent as { project: { isPublic: boolean; permissions?: unknown } }).project;
    expect(summary.isPublic).toBe(false);
    expect(summary.permissions).toBeDefined(); // owner sees grants

    const shared = await callTool(handler, token, "share_project", {
      project: "site",
      role: "read",
      add: ["friend@example.com"],
    });
    expect(shared.result?.isError).toBeUndefined();

    const unpublished = await callTool(handler, token, "unpublish_project", { project: "pub" });
    expect((unpublished.result?.structuredContent as { project: { isPublic: boolean } }).project.isPublic).toBe(false);

    const deleted = await callTool(handler, token, "delete_project", { project: "site" });
    expect(deleted.result?.structuredContent).toEqual({ ok: true });
    const gone = await callTool(handler, token, "project_info", { project: "site" });
    expect(gone.result?.isError).toBe(true);

    const who = await callTool(handler, token, "whoami", {});
    expect((who.result?.structuredContent as { user: { email: string } }).user.email).toBe(users.owner.email);
  });

  test("publish argument validation is strict", async () => {
    const handler = await appHandler({});
    const token = await mcpBearer(users.owner);
    const cases: Array<Record<string, unknown>> = [
      { files: [] },
      { files: [{ path: "a.html" }] },
      { files: [{ path: "a.html", content: "x", contentBase64: "eA==" }] },
      { files: [{ path: "../evil.html", content: "x" }] },
      { files: [{ path: "a.html", contentBase64: "not base64!!!" }] },
      { files: [{ path: "a.html", content: "x" }], unexpected: true },
    ];
    for (const args of cases) {
      const body = await callTool(handler, token, "publish", args);
      expect({ args, code: body.error?.code }).toEqual({ args, code: -32602 });
    }
  });
});

describe("mcp tools: policy parity with the route registry", () => {
  /** Every tool's backing endpoint exists in the route registry. */
  test("every tool names a registered endpoint, and tool names are unique", () => {
    const routeNames = new Set(API_ROUTES.map((route) => route.name));
    for (const tool of MCP_TOOLS) {
      expect({ tool: tool.name, registered: routeNames.has(tool.endpoint) }).toEqual({ tool: tool.name, registered: true });
    }
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
  });

  /** Success-shaped arguments per tool, parameterized by project. */
  const TOOL_ARGS: Record<string, (project: string) => unknown> = {
    publish: (project) => ({ files: [{ path: "index.html", content: "update" }], project }),
    list_projects: () => ({}),
    project_info: (project) => ({ project }),
    share_project: (project) => ({ project, role: "read", add: ["friend@example.com"] }),
    unpublish_project: (project) => ({ project }),
    delete_project: (project) => ({ project }),
    whoami: () => ({}),
  };

  const CREDENTIALS: ReadonlyArray<{ name: string; user: AuthUser; role: ProjectRole }> = [
    { name: "stranger", user: users.stranger, role: "none" },
    { name: "reader", user: users.reader, role: "read" },
    { name: "writer", user: users.writer, role: "write" },
    { name: "admin", user: users.admin, role: "admin" },
    { name: "owner", user: users.owner, role: "owner" },
  ];

  test("every tool has matrix arguments", () => {
    expect(Object.keys(TOOL_ARGS).sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
  });

  for (const tool of MCP_TOOLS) {
    for (const subject of [{ project: "site", isPublic: false }, { project: "pub", isPublic: true }] as const) {
      test(`${tool.name} on ${subject.isPublic ? "public" : "private"} project enforces ${tool.endpoint}'s policy`, async () => {
        const route = API_ROUTES.find((candidate) => candidate.name === tool.endpoint)!;
        // Mutating cells get a fresh server so no cell poisons another.
        const shared = route.mutation ? null : await fixture();
        for (const credential of CREDENTIALS) {
          const handler = shared ?? await fixture();
          const body = await callTool(handler, await mcpBearer(credential.user), tool.name, TOOL_ARGS[tool.name]!(subject.project));
          const label = `${tool.name} × ${credential.name} × ${subject.project}`;
          const isError = body.result?.isError === true;
          const text = body.result?.content?.[0]?.text ?? "";

          if (route.minimumRole == null) {
            expect({ label, isError }).toEqual({ label, isError: false });
            continue;
          }
          const role = subject.isPublic && !roleAtLeast(credential.role, "read") ? "read" : credential.role;
          if (roleAtLeast(role, route.minimumRole)) {
            expect({ label, isError, text }).toEqual({ label, isError: false, text });
          } else if (!roleAtLeast(role, "read")) {
            // Below read, existence is masked with the same message the HTTP
            // route sends: publish reads as a name collision, everything else
            // as a missing project.
            const masked = tool.name === "publish" ? text.includes("already taken") : text.includes("Project not found");
            expect({ label, isError, masked }).toEqual({ label, isError: true, masked: true });
          } else {
            expect({ label, isError }).toEqual({ label, isError: true });
            expect(text.includes("Project not found")).toBe(false); // denied, never masked as missing
          }
        }
      }, 30_000);
    }
  }
});
