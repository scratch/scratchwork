/*
 * Tests for apiRequest's Cloudflare Access behavior, run against real loopback
 * HTTP servers (nothing mocked): the stored Access JWT and service-token env
 * vars ride outgoing requests as headers, and responses blocked by Cloudflare's
 * edge (403 + cf-mitigated, or an Access login page) fail with a re-auth hint
 * instead of leaking an HTML page into the terminal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { apiRequest } from "../src/api";
import { writeAuthToken } from "../src/auth";

const TestLayer = Layer.mergeAll(FetchHttpClient.layer, BunContext.layer);
const run = (effect) => Effect.runPromise(Effect.provide(effect, TestLayer));

let home;
let previousHome;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "scratchwork-api-test-"));
  previousHome = process.env.SCRATCHWORK_HOME;
  process.env.SCRATCHWORK_HOME = home;
});
afterAll(() => {
  if (previousHome == null) delete process.env.SCRATCHWORK_HOME;
  else process.env.SCRATCHWORK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** Serves one canned response for the duration of a test. */
function withServer(handler, use) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const origin = `http://127.0.0.1:${server.port}`;
  return Promise.resolve(use(origin)).finally(() => server.stop(true));
}

describe("apiRequest Cloudflare Access headers", () => {
  afterEach(() => {
    delete process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID;
    delete process.env.SCRATCHWORK_CF_ACCESS_CLIENT_SECRET;
  });

  test("sends the stored Access JWT as cf-access-token", async () => {
    await withServer(
      (request) => Response.json({ headers: Object.fromEntries(request.headers) }),
      async (origin) => {
        await run(writeAuthToken(origin, "bearer-1", "a@b.co", "cf-jwt-1"));
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, { token: "bearer-1" }));
        expect(response.json.headers["cf-access-token"]).toBe("cf-jwt-1");
        expect(response.json.headers.authorization).toBe("Bearer bearer-1");
      },
    );
  });

  test("sends nothing extra when no Access JWT is stored for the origin", async () => {
    await withServer(
      (request) => Response.json({ headers: Object.fromEntries(request.headers) }),
      async (origin) => {
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, {}));
        expect(response.json.headers["cf-access-token"]).toBeUndefined();
        expect(response.json.headers["cf-access-client-id"]).toBeUndefined();
      },
    );
  });

  test("sends service-token headers when both env vars are set", async () => {
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID = "svc-id";
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_SECRET = "svc-secret";
    await withServer(
      (request) => Response.json({ headers: Object.fromEntries(request.headers) }),
      async (origin) => {
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, {}));
        expect(response.json.headers["cf-access-client-id"]).toBe("svc-id");
        expect(response.json.headers["cf-access-client-secret"]).toBe("svc-secret");
      },
    );
  });

  test("ignores a service-token id without a secret", async () => {
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID = "svc-id";
    await withServer(
      (request) => Response.json({ headers: Object.fromEntries(request.headers) }),
      async (origin) => {
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, {}));
        expect(response.json.headers["cf-access-client-id"]).toBeUndefined();
      },
    );
  });
});

describe("apiRequest Cloudflare edge-block detection", () => {
  test("a blocked CLI exchange explains the required narrow Access bypass", async () => {
    await withServer(
      () => new Response("Forbidden", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      async (origin) => {
        await expect(run(apiRequest("scratchwork login", `${origin}/auth/cli/token`, { method: "POST" })))
          .rejects.toThrow("configure a Bypass / Everyone policy limited to `/auth/cli/token`");
      },
    );
  });

  test("a 403 tagged cf-mitigated fails with the re-auth hint", async () => {
    await withServer(
      () => new Response("Forbidden", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      async (origin) => {
        await expect(run(apiRequest("scratchwork publish", `${origin}/api/publish`, {})))
          .rejects.toThrow("Cloudflare Access blocked this request. Run `scratchwork login` again");
      },
    );
  });

  test("an Access login page where JSON was expected fails with the re-auth hint", async () => {
    const loginPage = "<!DOCTYPE html><html><head><title>Sign in</title></head><body>myteam.cloudflareaccess.com</body></html>";
    await withServer(
      () => new Response(loginPage, { headers: { "content-type": "text/html" } }),
      async (origin) => {
        await expect(run(apiRequest("scratchwork projects", `${origin}/api/projects`, {})))
          .rejects.toThrow("Cloudflare Access blocked this request");
      },
    );
  });

  test("an ordinary 403 from the server is returned for the caller to interpret", async () => {
    await withServer(
      () => Response.json({ error: "Forbidden" }, { status: 403 }),
      async (origin) => {
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, {}));
        expect(response.status).toBe(403);
        expect(response.json).toEqual({ error: "Forbidden" });
      },
    );
  });

  test("an ordinary HTML error page without Access markers is not misread as a block", async () => {
    await withServer(
      () => new Response("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>oops</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
      async (origin) => {
        const response = await run(apiRequest("scratchwork test", `${origin}/api/me`, {}));
        expect(response.status).toBe(502);
      },
    );
  });
});
