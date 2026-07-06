import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as Effect from "effect/Effect";
import { decodeLoginCallback, normalizeServerUrl, readAuthToken, readCfToken, writeAuthToken } from "../src/auth";

describe("normalizeServerUrl", () => {
  test("defaults bare public hosts to the https app subdomain", () => {
    expect(normalizeServerUrl("sndbx.sh")).toBe("https://app.sndbx.sh");
    expect(normalizeServerUrl("sndbx.sh/")).toBe("https://app.sndbx.sh");
    expect(normalizeServerUrl("https://sndbx.sh")).toBe("https://app.sndbx.sh");
  });

  test("defaults loopback hosts to http", () => {
    expect(normalizeServerUrl("localhost:3001")).toBe("http://localhost:3001");
    expect(normalizeServerUrl("127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
  });

  test("preserves explicit schemes for subdomains and removes search/hash", () => {
    expect(normalizeServerUrl("https://www.sndbx.sh/?x=1#top")).toBe("https://www.sndbx.sh");
    expect(normalizeServerUrl("https://app.sndbx.sh/?x=1#top")).toBe("https://app.sndbx.sh");
    expect(normalizeServerUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });
});

describe("decodeLoginCallback", () => {
  test("reads the relayed cf_token when the server sends one", () => {
    const url = new URL("http://127.0.0.1:5555/callback?token=bearer-1&email=a%40b.co&server=https%3A%2F%2Fapp.b.co&cf_token=cf-jwt-1");
    expect(decodeLoginCallback(url)).toEqual({
      token: "bearer-1",
      email: "a@b.co",
      server: "https://app.b.co",
      cfToken: "cf-jwt-1",
    });
  });

  test("leaves cfToken unset when the server does not relay one", () => {
    const url = new URL("http://127.0.0.1:5555/callback?token=bearer-1");
    const decoded = decodeLoginCallback(url);
    expect(decoded?.token).toBe("bearer-1");
    expect(decoded?.cfToken).toBeUndefined();
  });
});

describe("auth.json cfToken storage", () => {
  let home;
  let previousHome;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "scratchwork-auth-test-"));
    previousHome = process.env.SCRATCHWORK_HOME;
    process.env.SCRATCHWORK_HOME = home;
  });
  afterAll(() => {
    if (previousHome == null) delete process.env.SCRATCHWORK_HOME;
    else process.env.SCRATCHWORK_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const run = (effect) => Effect.runPromise(Effect.provide(effect, BunContext.layer));

  test("round-trips the cfToken alongside the bearer token", async () => {
    await run(writeAuthToken("https://app.cf.example", "bearer-1", "a@b.co", "cf-jwt-1"));
    expect(await run(readAuthToken("https://app.cf.example"))).toBe("bearer-1");
    expect(await run(readCfToken("https://app.cf.example"))).toBe("cf-jwt-1");
    // The content-host origin fallback finds it too, like readAuthToken.
    expect(await run(readCfToken("https://pages.cf.example"))).toBe("cf-jwt-1");
  });

  test("a login without a cfToken stores none, and old auth files still read", async () => {
    await run(writeAuthToken("https://app.plain.example", "bearer-2", "a@b.co"));
    expect(await run(readAuthToken("https://app.plain.example"))).toBe("bearer-2");
    expect(await run(readCfToken("https://app.plain.example"))).toBeUndefined();

    // A file written by an older CLI (no cfToken fields anywhere) is untouched by the
    // reader and never treated as corrupt.
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      version: 1,
      servers: { "https://app.old.example": { token: "bearer-3", updatedAt: "2026-01-01T00:00:00.000Z" } },
    }));
    expect(await run(readAuthToken("https://app.old.example"))).toBe("bearer-3");
    expect(await run(readCfToken("https://app.old.example"))).toBeUndefined();
  });
});
