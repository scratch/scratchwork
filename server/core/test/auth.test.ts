import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { createSessionToken, makeAuth, type AuthUser } from "../src/auth";
import { readServerConfig, type AuthConfig } from "../src/config";

const user: AuthUser = {
  id: "google-user-1",
  email: "founder@example.com",
  name: "Founder",
};

const googleConfig: AuthConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  sessionSecret: "session-secret-session-secret-32-bytes",
  allowedUsers: "public",
  sessionTtlSeconds: 60,
};

describe("Auth", () => {
  test("accepts a signed bearer session token", async () => {
    const token = await Effect.runPromise(createSessionToken(user, googleConfig));
    const auth = makeAuth(googleConfig);

    const currentUser = await Effect.runPromise(
      auth.currentUser(request({ authorization: `Bearer ${token}` })),
    );

    expect(currentUser?.email).toBe("founder@example.com");
  });

  test("rejects a signed token outside allowed domains", async () => {
    const config = { ...googleConfig, allowedUsers: "@yc.com" };
    const token = await Effect.runPromise(createSessionToken(user, config));
    const auth = makeAuth(config);

    const currentUser = await Effect.runPromise(
      auth.currentUser(request({ authorization: `Bearer ${token}` })),
    );

    expect(currentUser).toBeNull();
  });

  test("does not accept cookie sessions for API publish auth", async () => {
    const token = await Effect.runPromise(createSessionToken(user, googleConfig));
    const auth = makeAuth(googleConfig);

    await expect(
      Effect.runPromise(auth.requireApiUser(request({ cookie: `scratchwork_session=${encodeURIComponent(token)}` }))),
    ).rejects.toThrow("Authentication required");
  });
});

describe("readServerConfig", () => {
  test("reads OAuth settings from environment", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_AUTH: "oauth",
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_AUTH_ALLOWED_DOMAINS: "example.com, yc.com",
      }),
    );

    expect(config.auth.allowedUsers).toBe("@example.com,@yc.com");
  });

  test("rejects auth modes other than oauth", async () => {
    await expect(
      Effect.runPromise(
        readServerConfig({
          SCRATCHWORK_AUTH: "google",
          SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
          SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
          SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        }),
      ),
    ).rejects.toThrow('SCRATCHWORK_AUTH must be "oauth" when set');
  });

  test("fails without OAuth credentials", async () => {
    await expect(Effect.runPromise(readServerConfig({}))).rejects.toThrow(
      "OAuth is required",
    );
  });

  test("defaults routing and workspace settings deterministically", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      }),
    );

    expect(config.projectRoutingMode).toBe("workspace/project");
    expect(config.defaultWorkspace).toBe("username");
    expect(config.usersCanCreateWorkspaces).toBe(true);
  });

  test("reads the configured routing and workspace settings", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_PROJECT_ROUTING_MODE: "userDomain/workspace/project",
        SCRATCHWORK_DEFAULT_WORKSPACE: "random",
        SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES: "false",
      }),
    );

    expect(config.projectRoutingMode).toBe("userDomain/workspace/project");
    expect(config.defaultWorkspace).toBe("random");
    expect(config.usersCanCreateWorkspaces).toBe(false);
  });

  test("rejects unknown routing and workspace values", async () => {
    const base = {
      SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
      SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
      SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
    };
    await expect(
      Effect.runPromise(readServerConfig({ ...base, SCRATCHWORK_PROJECT_ROUTING_MODE: "random" })),
    ).rejects.toThrow("SCRATCHWORK_PROJECT_ROUTING_MODE must be workspace/project or userDomain/workspace/project");
    await expect(
      Effect.runPromise(readServerConfig({ ...base, SCRATCHWORK_DEFAULT_WORKSPACE: "team" })),
    ).rejects.toThrow("SCRATCHWORK_DEFAULT_WORKSPACE must be username or random");
    await expect(
      Effect.runPromise(readServerConfig({ ...base, SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES: "yes" })),
    ).rejects.toThrow("SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES must be true or false");
  });
});

/** Fabricates an HttpServerRequest carrying the given headers. */
function request(headers: Record<string, string>): HttpServerRequest.HttpServerRequest {
  return { headers } as HttpServerRequest.HttpServerRequest;
}
