/*
 * CLI auth unit tests: the localhost callback listener (incl. the CSRF state
 * guard) and the credential → header logic.
 */
import { test, expect, describe, afterEach } from "bun:test";
import * as Effect from "effect/Effect";
import { waitForCallback, generateCallbackState, generateCliCode } from "../src/lib/auth-callback.ts";
import { buildHeaders } from "../src/lib/server-client.ts";
import { resolveAuth } from "../src/lib/config.ts";

let nextPort = 8455; // distinct port per test; avoid the real 8400

describe("buildHeaders", () => {
  test("api_key → X-Api-Key", () => {
    expect(buildHeaders({ token: "scratchwork_x", type: "api_key" })).toEqual({ "X-Api-Key": "scratchwork_x" });
  });
  test("session/bearer → Authorization: Bearer", () => {
    expect(buildHeaders({ token: "t", type: "session" })).toEqual({ Authorization: "Bearer t" });
    expect(buildHeaders({ token: "t", type: "bearer" })).toEqual({ Authorization: "Bearer t" });
  });
  test("cfToken adds cf-access-token", () => {
    expect(buildHeaders({ token: "t", type: "session", cfToken: "cf" })).toEqual({ Authorization: "Bearer t", "cf-access-token": "cf" });
  });
  test("no token → empty", () => {
    expect(buildHeaders(null)).toEqual({});
  });
});

describe("resolveAuth (env)", () => {
  const saved = process.env.SCRATCHWORK_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCRATCHWORK_TOKEN;
    else process.env.SCRATCHWORK_TOKEN = saved;
  });
  test("scratchwork_ prefix → api_key; else bearer", async () => {
    process.env.SCRATCHWORK_TOKEN = "scratchwork_abc";
    expect(await Effect.runPromise(resolveAuth("https://x"))).toEqual({ token: "scratchwork_abc", type: "api_key" });
    process.env.SCRATCHWORK_TOKEN = "deadbeef";
    expect(await Effect.runPromise(resolveAuth("https://x"))).toEqual({ token: "deadbeef", type: "bearer" });
  });
});

describe("waitForCallback", () => {
  test("resolves on matching state + token", async () => {
    const port = nextPort++;
    const p = Effect.runPromise(waitForCallback(port, "S1", 5000));
    await new Promise((r) => setTimeout(r, 80));
    const res = await fetch(`http://127.0.0.1:${port}/callback?state=S1&token=TOK&cf_token=CF`);
    expect(res.status).toBe(200);
    expect(await p).toEqual({ token: "TOK", cfToken: "CF" });
  });

  test("wrong state → 400 and keeps listening until the right one arrives", async () => {
    const port = nextPort++;
    const p = Effect.runPromise(waitForCallback(port, "S2", 5000));
    await new Promise((r) => setTimeout(r, 80));
    const bad = await fetch(`http://127.0.0.1:${port}/callback?state=WRONG&token=NOPE`);
    expect(bad.status).toBe(400);
    // still listening: a correct callback now resolves it
    const ok = await fetch(`http://127.0.0.1:${port}/callback?state=S2&token=GOOD`);
    expect(ok.status).toBe(200);
    expect((await p).token).toBe("GOOD");
  });

  test("error param rejects", async () => {
    const port = nextPort++;
    const p = Effect.runPromise(waitForCallback(port, "S3", 5000));
    let rejectedWith = null;
    p.catch((e) => {
      rejectedWith = e.message;
    });
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/callback?state=S3&error=access_denied`);
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(rejectedWith).toBe("access_denied");
  });

  test("error with WRONG state does not abort (keeps listening)", async () => {
    const port = nextPort++;
    const p = Effect.runPromise(waitForCallback(port, "S4", 5000));
    let settled = null;
    p.then(() => (settled = "resolved"), () => (settled = "rejected"));
    await new Promise((r) => setTimeout(r, 100));
    // spurious error with the wrong state → 400, must NOT reject the login
    const bad = await fetch(`http://127.0.0.1:${port}/callback?state=WRONG&error=access_denied`);
    expect(bad.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeNull();
    // the real callback still completes
    const ok = await fetch(`http://127.0.0.1:${port}/callback?state=S4&token=GOOD`);
    expect(ok.status).toBe(200);
    expect((await p).token).toBe("GOOD");
  });

  test("code/state generators", () => {
    expect(generateCallbackState()).toMatch(/[0-9a-f-]{36}/);
    expect(generateCliCode()).toHaveLength(6);
  });
});
