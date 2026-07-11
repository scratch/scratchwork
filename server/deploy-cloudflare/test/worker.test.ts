import { describe, expect, test } from "bun:test";
import worker, { envVarsFromCloudflare } from "../src/worker";

/** Minimal R2/D1 binding stubs; requests that die in config never reach them. */
const bindings = {
  SCRATCHWORK_R2: { get: async () => null, put: async () => null },
  SCRATCHWORK_D1: {
    prepare: () => ({
      bind: function () {
        return this;
      },
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  },
};

describe("worker fetch", () => {
  test("a misconfigured worker answers 500 instead of throwing", async () => {
    // The exact outage this guards against: an invalid access group in config made
    // every request — including /health — escape as an unhandled Worker exception.
    const env = {
      ...bindings,
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
      SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
      SCRATCHWORK_MAX_VISIBILITY: "gmail.com,koomen.org",
    };
    const response = await worker.fetch(new Request("https://scratch.test/health"), env as never, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  test("a well-configured worker serves /health", async () => {
    const env = {
      ...bindings,
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
      SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
      SCRATCHWORK_MAX_VISIBILITY: "@gmail.com,@koomen.org",
    };
    const response = await worker.fetch(new Request("https://scratch.test/health"), env as never, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("a Cloudflare Access worker serves /health without OAuth credentials", async () => {
    const env = {
      ...bindings,
      SCRATCHWORK_AUTH: "cloudflare-access",
      SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: "myteam",
      SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
      SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
    };
    const response = await worker.fetch(new Request("https://scratch.test/health"), env as never, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("envVarsFromCloudflare", () => {
  test("copies string server env vars and excludes bindings", () => {
    const vars = envVarsFromCloudflare({
      SCRATCHWORK_R2: { get: async () => null, put: async () => null },
      SCRATCHWORK_D1: {
        prepare: () => ({
          bind: function () {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      },
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_APP_URL: "https://scratch.test",
      GOOGLE_CLIENT_ID: "client-id",
      PORT: "3001",
      NOT_INCLUDED: "no",
    });

    expect(vars.SCRATCHWORK_AUTH).toBe("oauth");
    expect(vars.SCRATCHWORK_APP_URL).toBe("https://scratch.test");
    expect(vars.GOOGLE_CLIENT_ID).toBe("client-id");
    expect(vars.PORT).toBe("3001");
    expect(vars.NOT_INCLUDED).toBeUndefined();
    expect(vars.SCRATCHWORK_R2).toBeUndefined();
  });
});
