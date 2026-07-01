import { describe, expect, test } from "bun:test";
import { envVarsFromCloudflare } from "../src/worker";

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
      SCRATCHWORK_AUTH: "google",
      SCRATCHWORK_PUBLIC_URL: "https://scratch.test",
      GOOGLE_CLIENT_ID: "client-id",
      PORT: "3001",
      NOT_INCLUDED: "no",
    });

    expect(vars.SCRATCHWORK_AUTH).toBe("google");
    expect(vars.SCRATCHWORK_PUBLIC_URL).toBe("https://scratch.test");
    expect(vars.GOOGLE_CLIENT_ID).toBe("client-id");
    expect(vars.PORT).toBe("3001");
    expect(vars.NOT_INCLUDED).toBeUndefined();
    expect(vars.SCRATCHWORK_R2).toBeUndefined();
  });
});
