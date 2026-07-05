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

  test("binds project-access tokens to one project, scope, and use", async () => {
    const auth = makeAuth(googleConfig);
    const token = await Effect.runPromise(auth.issueProjectAccessToken("site", user, "cookie"));

    // The payload carries the project, the path scope, and the access-token version.
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(token.split(".")[0])));
    expect(payload.version).toBe(1);
    expect(payload.project).toBe("site");
    expect(payload.scope).toBe("/site");

    expect((await Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "cookie")))?.email).toBe(user.email);
    // A token for one project does not verify for another, nor across uses.
    expect(await Effect.runPromise(auth.verifyProjectAccessToken(token, "other", "cookie"))).toBeNull();
    expect(await Effect.runPromise(auth.verifyProjectAccessToken(token, "site", "handoff"))).toBeNull();
  });

  test("rejects old-format project-access tokens as invalid, not as a crash", async () => {
    const auth = makeAuth(googleConfig);
    // A token in the retired workspace-era shape (projectKey/routePath) signed with the
    // real secret must fail schema decode and read as an invalid token.
    const legacy = await signLegacyToken(
      {
        version: 1,
        kind: "project-access",
        use: "cookie",
        projectKey: "demo/site",
        routePath: "demo/site",
        email: user.email,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      googleConfig.sessionSecret,
    );

    await expect(
      Effect.runPromise(auth.verifyProjectAccessToken(legacy, "site", "cookie")),
    ).rejects.toThrow("Invalid auth token");
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

  test("defaults to user-set project names", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
      }),
    );

    expect(config.usersCanSetProjectNames).toBe(true);
  });

  test("reads the configured project-naming setting", async () => {
    const config = await Effect.runPromise(
      readServerConfig({
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "false",
      }),
    );

    expect(config.usersCanSetProjectNames).toBe(false);
  });

  test("rejects non-boolean project-naming values", async () => {
    await expect(
      Effect.runPromise(readServerConfig({
        SCRATCHWORK_GOOGLE_CLIENT_ID: "client-id",
        SCRATCHWORK_GOOGLE_CLIENT_SECRET: "client-secret",
        SCRATCHWORK_SESSION_SECRET: "session-secret-session-secret-32-bytes",
        SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES: "yes",
      })),
    ).rejects.toThrow("SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES must be true or false");
  });
});

/** Fabricates an HttpServerRequest carrying the given headers. */
function request(headers: Record<string, string>): HttpServerRequest.HttpServerRequest {
  return { headers } as HttpServerRequest.HttpServerRequest;
}

/** Decodes a base64url string into bytes. */
function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Signs an arbitrary payload the same way the auth service does, so tests can craft
 * tokens in retired payload shapes. */
async function signLegacyToken(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Encodes bytes as base64url. */
function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
