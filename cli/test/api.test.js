/*
 * Tests for the contract-derived API client's transport behavior, run against
 * real loopback HTTP servers (nothing mocked): the bearer token, stored Access
 * JWT, and service-token env vars ride outgoing requests as headers; responses
 * blocked by Cloudflare's edge (403 + cf-mitigated, or an Access login page)
 * fail with a re-auth hint; and other failures surface as ApiError with the
 * extracted error text instead of leaking an HTML page into the terminal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { apiClient, mapApiErrors } from "../src/api";
import { writeAuthToken } from "../src/auth";

const TestLayer = Layer.mergeAll(FetchHttpClient.layer, BunContext.layer);
const run = (effect) => Effect.runPromise(Effect.provide(effect, TestLayer));

/** Calls GET /api/me through the derived client. */
const callMe = (origin, options = {}) =>
  Effect.flatMap(apiClient(origin, options), (client) => client.me());

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

/** Serves one canned response for the duration of a test, capturing request headers. */
function withServer(handler, use) {
  const seen = { headers: null };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.headers = Object.fromEntries(request.headers);
      return handler(request);
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return Promise.resolve(use(origin, seen)).finally(() => server.stop(true));
}

const ME_BODY = { authenticated: true, user: { id: "u1", email: "a@b.co" } };

describe("apiClient Cloudflare Access headers", () => {
  afterEach(() => {
    delete process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID;
    delete process.env.SCRATCHWORK_CF_ACCESS_CLIENT_SECRET;
  });

  test("sends the bearer token and the stored Access JWT as cf-access-token", async () => {
    await withServer(
      () => Response.json(ME_BODY),
      async (origin, seen) => {
        await run(writeAuthToken(origin, "bearer-1", "a@b.co", "cf-jwt-1"));
        const body = await run(callMe(origin, { token: "bearer-1" }));
        expect(seen.headers["cf-access-token"]).toBe("cf-jwt-1");
        expect(seen.headers.authorization).toBe("Bearer bearer-1");
        // The 2xx body is decoded through the shared contract schema.
        expect(body).toEqual(ME_BODY);
      },
    );
  });

  test("sends nothing extra when no Access JWT is stored for the origin", async () => {
    await withServer(
      () => Response.json(ME_BODY),
      async (origin, seen) => {
        await run(callMe(origin));
        expect(seen.headers["cf-access-token"]).toBeUndefined();
        expect(seen.headers["cf-access-client-id"]).toBeUndefined();
        expect(seen.headers.authorization).toBeUndefined();
      },
    );
  });

  test("sends service-token headers when both env vars are set", async () => {
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID = "svc-id";
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_SECRET = "svc-secret";
    await withServer(
      () => Response.json(ME_BODY),
      async (origin, seen) => {
        await run(callMe(origin));
        expect(seen.headers["cf-access-client-id"]).toBe("svc-id");
        expect(seen.headers["cf-access-client-secret"]).toBe("svc-secret");
      },
    );
  });

  test("ignores a service-token id without a secret", async () => {
    process.env.SCRATCHWORK_CF_ACCESS_CLIENT_ID = "svc-id";
    await withServer(
      () => Response.json(ME_BODY),
      async (origin, seen) => {
        await run(callMe(origin));
        expect(seen.headers["cf-access-client-id"]).toBeUndefined();
      },
    );
  });
});

describe("apiClient Cloudflare edge-block detection", () => {
  test("a blocked CLI exchange explains the required narrow Access bypass", async () => {
    await withServer(
      () => new Response("Forbidden", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      async (origin) => {
        const exchange = Effect.flatMap(apiClient(origin), (client) =>
          client["cli-token-exchange"]({
            payload: { code: "not-a-real-code", codeVerifier: "v".repeat(43), redirectUri: "http://127.0.0.1:1/cb" },
          }),
        ).pipe(mapApiErrors("scratchwork login"));
        await expect(run(exchange))
          .rejects.toThrow("configure a Bypass / Everyone policy limited to `/auth/cli/token`");
      },
    );
  });

  test("a 403 tagged cf-mitigated fails with the re-auth hint", async () => {
    await withServer(
      () => new Response("Forbidden", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      async (origin) => {
        await expect(run(callMe(origin).pipe(mapApiErrors("scratchwork publish"))))
          .rejects.toThrow("Cloudflare Access blocked this request. Run `scratchwork login` again");
      },
    );
  });

  test("an Access login page where JSON was expected fails with the re-auth hint", async () => {
    const loginPage = "<!DOCTYPE html><html><head><title>Sign in</title></head><body>myteam.cloudflareaccess.com</body></html>";
    await withServer(
      () => new Response(loginPage, { headers: { "content-type": "text/html" } }),
      async (origin) => {
        const list = Effect.flatMap(apiClient(origin), (client) => client["projects-list"]())
          .pipe(mapApiErrors("scratchwork projects"));
        await expect(run(list)).rejects.toThrow("Cloudflare Access blocked this request");
      },
    );
  });

  test("an ordinary error envelope surfaces as ApiError with its status and message", async () => {
    await withServer(
      () => Response.json({ error: "Forbidden" }, { status: 403 }),
      async (origin) => {
        const error = await run(callMe(origin).pipe(Effect.flip));
        expect(error._tag).toBe("ApiError");
        expect(error.status).toBe(403);
        expect(error.message).toBe("Forbidden");
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
        const error = await run(callMe(origin).pipe(Effect.flip));
        expect(error._tag).toBe("ApiError");
        expect(error.status).toBe(502);
        expect(error.message).toBe("server returned 502: 502 Bad Gateway");
      },
    );
  });
});

describe("apiClient transport retry", () => {
  /**
   * Serves the /api/me body over raw TCP, killing the first `failures`
   * connections as soon as request bytes arrive — the shape a stale
   * keep-alive socket takes after a proxy (Cloudflare's edge) idle-closes it
   * under a long-running `scratchwork stream`. Returns the origin, a
   * connection counter, and a close function.
   */
  function rawServer(failures) {
    const body = JSON.stringify(ME_BODY);
    const response = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
    const seen = { connections: 0 };
    const server = createServer((socket) => {
      seen.connections += 1;
      const kill = seen.connections <= failures;
      socket.on("data", () => (kill ? socket.destroy() : socket.end(response)));
      socket.on("error", () => {});
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({
          origin: `http://127.0.0.1:${server.address().port}`,
          seen,
          close: () => new Promise((done) => server.close(done)),
        });
      });
    });
  }

  test("retries a connection closed before any response on a fresh connection", async () => {
    const { origin, seen, close } = await rawServer(1);
    try {
      const body = await run(callMe(origin));
      expect(body).toEqual(ME_BODY);
      expect(seen.connections).toBe(2);
    } finally {
      await close();
    }
  });

  test("a persistent transport failure surfaces after the retries are spent", async () => {
    const { origin, seen, close } = await rawServer(Infinity);
    try {
      const error = await run(callMe(origin).pipe(Effect.flip));
      expect(error._tag).toBe("ApiError");
      expect(error.status).toBeNull();
      expect(seen.connections).toBe(3);
    } finally {
      await close();
    }
  });

  test("does not retry a response the server actually sent", async () => {
    let requests = 0;
    await withServer(
      () => {
        requests += 1;
        return Response.json({ error: "boom" }, { status: 500 });
      },
      async (origin) => {
        const error = await run(callMe(origin).pipe(Effect.flip));
        expect(error._tag).toBe("ApiError");
        expect(error.status).toBe(500);
        expect(error.message).toBe("boom");
        expect(requests).toBe(1);
      },
    );
  });
});
