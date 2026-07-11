#!/usr/bin/env bun
/** Manual smoke test for a running local Cloudflare server. It exercises the simulated
 * Access login, D1-backed project metadata, and R2-backed file storage. */
const origin = process.env.SCRATCHWORK_LOCAL_ORIGIN ?? "http://localhost:8787";
const project = process.env.SCRATCHWORK_LOCAL_SMOKE_PROJECT ?? "cloudflare-local-smoke";

const login = await fetch(
  `${origin}/auth/login?cli_redirect=${encodeURIComponent("http://127.0.0.1:49123/callback")}`,
  { redirect: "manual" },
);
const location = login.headers.get("location");
if (location == null) throw new Error(`Local Access login failed: ${login.status} ${await login.text()}`);
const callback = new URL(location);
const token = callback.searchParams.get("token");
const cfToken = callback.searchParams.get("cf_token");
if (token == null || cfToken == null) throw new Error("Local Access login did not return both CLI tokens");

const marker = `R2 + D1 + Access work (${Date.now()})`;
const publish = await fetch(`${origin}/api/publish`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "cf-access-token": cfToken,
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
  email: callback.searchParams.get("email"),
}, null, 2));
