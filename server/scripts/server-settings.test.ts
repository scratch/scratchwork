import { describe, expect, test } from "bun:test";
import { serverConfigEnv, type ScratchworkServerConfig } from "./server-settings";

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
