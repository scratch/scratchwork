import { describe, expect, test } from "bun:test";
import { serverConfigEnv, validateDeploymentConfig, type ScratchworkServerConfig } from "./server-settings";

describe("serverConfigEnv", () => {
  test("maps usersCanSetProjectNames onto its environment variable", () => {
    expect(serverConfigEnv({ auth: "oauth", usersCanSetProjectNames: true }, {})).toEqual({
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "true",
    });
    expect(serverConfigEnv({ auth: "oauth", usersCanSetProjectNames: false }, {})).toEqual({
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "false",
    });
    expect(serverConfigEnv({ auth: "oauth" }, {})).toEqual({ SCRATCHWORK_AUTH: "oauth" });
  });

  test("never emits the retired workspace-era variables", () => {
    const config: ScratchworkServerConfig = {
      auth: "oauth",
      allowedUsers: "public",
      allowPublicProjects: true,
      usersCanSetProjectNames: true,
    };
    const env = serverConfigEnv(config, { appUrl: "https://app.example", contentUrl: "https://pages.example" });

    expect(Object.keys(env)).not.toContain("SCRATCHWORK_PROJECT_ROUTING_MODE");
    expect(Object.keys(env)).not.toContain("SCRATCHWORK_DEFAULT_WORKSPACE");
    expect(Object.keys(env)).not.toContain("SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES");
    expect(env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES).toBe("true");
    expect(env.SCRATCHWORK_APP_URL).toBe("https://app.example");
    expect(env.SCRATCHWORK_CONTENT_URL).toBe("https://pages.example");
  });

  test("maps the homepage settings onto their environment variables", () => {
    expect(serverConfigEnv({ auth: "oauth", homepageDomains: ["example.com", "www.example.com"], homepageProject: "home" }, {})).toEqual({
      SCRATCHWORK_AUTH: "oauth",
      SCRATCHWORK_HOMEPAGE_DOMAINS: "example.com,www.example.com",
      SCRATCHWORK_HOMEPAGE_PROJECT: "home",
    });
  });

  test("maps the Cloudflare Access settings onto their environment variables", () => {
    expect(serverConfigEnv({ auth: "cloudflare-access", cfAccessTeamDomain: "myteam", cfAccessAud: "aud-tag-1" }, {})).toEqual({
      SCRATCHWORK_AUTH: "cloudflare-access",
      SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: "myteam",
      SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
    });
  });
});

describe("validateDeploymentConfig", () => {
  const baseEnv = {
    SCRATCHWORK_AUTH: "oauth",
    SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
    SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
    SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
    SCRATCHWORK_APP_URL: "https://app.example",
    SCRATCHWORK_CONTENT_URL: "https://pages.example",
  };

  test("accepts a config the server can parse", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_ALLOWED_USERS: "@gmail.com,@koomen.org" })).not.toThrow();
  });

  test("rejects values the deployed server would crash on at runtime", () => {
    // Domains without the leading "@" are not valid group terms.
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_ALLOWED_USERS: "gmail.com,koomen.org" }))
      .toThrow("Invalid access group");
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_ALLOW_PUBLIC_PROJECTS: "@example.com" }))
      .toThrow('expected "true" or "false"');
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_APP_URL: "not a url" }))
      .toThrow('expected a URL, like "https://example.com"');
  });

  test("rejects retired variable names", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_SHARE_ALLOWED_DOMAINS: "example.com" }))
      .toThrow("SCRATCHWORK_ALLOWED_SHARE_DOMAINS");
  });

  test("still enforces the OAuth requirements", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_SESSION_SECRET: undefined }))
      .toThrow("SCRATCHWORK_SESSION_SECRET is required");
  });

  test("rejects a config that never chooses an auth mode", () => {
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_AUTH: undefined }))
      .toThrow("SCRATCHWORK_AUTH is required");
  });

  test("accepts a Cloudflare Access config without OAuth credentials", () => {
    const cfEnv = {
      SCRATCHWORK_AUTH: "cloudflare-access",
      SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN: "myteam",
      SCRATCHWORK_CF_ACCESS_AUD: "aud-tag-1",
      SCRATCHWORK_SESSION_SECRET: "test-session-secret-test-session-secret",
      SCRATCHWORK_APP_URL: "https://app.example",
      SCRATCHWORK_CONTENT_URL: "https://pages.example",
    };
    expect(() => validateDeploymentConfig(cfEnv)).not.toThrow();
    expect(() => validateDeploymentConfig({ ...cfEnv, SCRATCHWORK_CF_ACCESS_AUD: undefined }))
      .toThrow("SCRATCHWORK_CF_ACCESS_AUD is required");
    expect(() => validateDeploymentConfig({ ...cfEnv, SCRATCHWORK_SESSION_SECRET: undefined }))
      .toThrow("SCRATCHWORK_SESSION_SECRET is required");
  });

  test("validates the homepage settings", () => {
    const homepage = {
      SCRATCHWORK_HOMEPAGE_DOMAINS: "example.com,www.example.com",
      SCRATCHWORK_HOMEPAGE_PROJECT: "home",
    };
    expect(() => validateDeploymentConfig({ ...baseEnv, ...homepage })).not.toThrow();

    // Set both or neither.
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_HOMEPAGE_PROJECT: "home" }))
      .toThrow("must be set together");
    expect(() => validateDeploymentConfig({ ...baseEnv, SCRATCHWORK_HOMEPAGE_DOMAINS: "example.com" }))
      .toThrow("must be set together");

    // The homepage project must be a publishable name.
    expect(() => validateDeploymentConfig({ ...baseEnv, ...homepage, SCRATCHWORK_HOMEPAGE_PROJECT: "api" }))
      .toThrow("a publishable project name");
    expect(() => validateDeploymentConfig({ ...baseEnv, ...homepage, SCRATCHWORK_HOMEPAGE_PROJECT: "_www" }))
      .toThrow("a publishable project name");

    // Home domains cannot collide with the app or content hosts.
    expect(() => validateDeploymentConfig({ ...baseEnv, ...homepage, SCRATCHWORK_HOMEPAGE_DOMAINS: "app.example" }))
      .toThrow("distinct from the app and content origins");
  });
});
