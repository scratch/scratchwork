#!/usr/bin/env bun
/** Manual smoke test for a running local Cloudflare server. It exercises the simulated
 * Access login (through the CLI code + PKCE exchange), D1-backed project metadata, and
 * R2-backed file storage. */
const origin = process.env.SCRATCHWORK_LOCAL_ORIGIN ?? "http://localhost:8787";
const project = process.env.SCRATCHWORK_LOCAL_SMOKE_PROJECT ?? "cloudflare-local-smoke";

// The CLI login handoff: the loopback callback receives only a one-time code bound
// to this state and PKCE challenge; the bearer and relayed Access JWT come from the
// back-channel exchange.
const redirectUri = "http://127.0.0.1:49123/callback";
const state = crypto.randomUUID();
const verifierBytes = new Uint8Array(32);
crypto.getRandomValues(verifierBytes);
const codeVerifier = Buffer.from(verifierBytes).toString("base64url");
const challengeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
const codeChallenge = Buffer.from(challengeDigest).toString("base64url");

const loginUrl = new URL(`${origin}/auth/login`);
loginUrl.searchParams.set("cli_redirect", redirectUri);
loginUrl.searchParams.set("cli_state", state);
loginUrl.searchParams.set("cli_code_challenge", codeChallenge);
const login = await fetch(loginUrl, { redirect: "manual" });
const location = login.headers.get("location");
if (location == null) throw new Error(`Local Access login failed: ${login.status} ${await login.text()}`);
const callback = new URL(location);
if (callback.searchParams.get("state") !== state) throw new Error("Local Access login echoed the wrong state");
const code = callback.searchParams.get("code");
if (code == null) throw new Error("Local Access login did not return an authorization code");

const exchange = await fetch(`${origin}/auth/cli/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, codeVerifier, redirectUri }),
});
const exchanged = await exchange.json() as {
  readonly token?: string;
  readonly cfToken?: string;
  readonly email?: string;
  readonly error?: string;
};
if (!exchange.ok || exchanged.token == null || exchanged.cfToken == null) {
  throw new Error(`Local CLI code exchange failed: ${exchange.status} ${JSON.stringify(exchanged)}`);
}

const marker = `R2 + D1 + Access work (${Date.now()})`;
const publish = await fetch(`${origin}/api/publish`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${exchanged.token}`,
    "cf-access-token": exchanged.cfToken,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    bundle: {
      version: 1,
      files: [{ path: "index.html", contentBase64: btoa(`<h1>${marker}</h1>`) }],
    },
    openPath: "/",
    project,
    isPublic: true,
  }),
});
const published = await publish.json() as { readonly project?: string; readonly error?: string };
if (!publish.ok) throw new Error(`Local publish failed: ${publish.status} ${JSON.stringify(published)}`);

const site = await fetch(`${origin}/${project}/`);
const html = await site.text();
if (!site.ok || !html.includes(marker)) throw new Error(`Local site read failed: ${site.status} ${html}`);

console.log(JSON.stringify({
  login: login.status,
  publish: publish.status,
  site: site.status,
  project: published.project,
  email: exchanged.email,
}, null, 2));
