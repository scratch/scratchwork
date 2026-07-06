import { describe, expect, test } from "bun:test";
import { serverConfigEnv, validateDeploymentConfig, type ScratchworkServerConfig } from "./server-settings";

describe("serverConfigEnv", () => {
  test("maps usersCanSetProjectNames onto its environment variable", () => {
    expect(serverConfigEnv({ usersCanSetProjectNames: true }, {})).toEqual({
      SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "true",
    });
    expect(serverConfigEnv({ usersCanSetProjectNames: false }, {})).toEqual({
      SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "false",
    });
    expect(serverConfigEnv({}, {})).toEqual({});
  });

  test("never emits the retired workspace-era variables", () => {
    const config: ScratchworkServerConfig = {
      auth: "oauth",
      allowedUsers: "public",
      maxVisibility: "public",
      usersCanSetProjectNames: true,
      defaultVisibility: "private",
    };
    const env = serverConfigEnv(config, { appUrl: "https://app.example", contentUrl: "https://pages.example" });

    expect(Object.keys(env)).not.toContain("SCRATCHWORK_PROJECT_ROUTING_MODE");
    expect(Object.keys(env)).not.toContain("SCRATCHWORK_DEFAULT_WORKSPACE");
    expect(Object.keys(env)).not.toContain("SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES");
    expect(env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES).toBe("true");
    expect(env.SCRATCHWORK_APP_URL).toBe("https://app.example");
    expect(env.SCRATCHWORK_CONTENT_URL).toBe("https://pages.example");
  });
});

describe("validateDeploymentConfig", () => {
  const baseEnv = {
    SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
    SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
    SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
    SCRATCHWORK_APP_URL: "https://app.example",
    SCRATCHWORK_CONTENT_URL: "https://pages.example",
  };

  test("accepts a config the server can parse", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_MAX_VISIBILITY: "@gmail.com,@koomen.org" }, "Test")).not.toThrow();
  });

  test("rejects values the deployed server would crash on at runtime", () => {
    // Domains without the leading "@" are not valid group terms.
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_MAX_VISIBILITY: "gmail.com,koomen.org" }, "Test"))
      .toThrow("Invalid access group");
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_DEFAULT_VISIBILITY: "@example.com" }, "Test"))
      .toThrow('expected "public" or "private"');
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_APP_URL: "not a url" }, "Test"))
      .toThrow('expected a URL, like "https://example.com"');
  });

  test("still enforces the OAuth requirements", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_SESSION_SECRET: undefined }, "Test"))
      .toThrow("SCRATCHWORK_SESSION_SECRET is required");
  });
});
