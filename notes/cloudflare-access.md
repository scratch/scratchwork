# Cloudflare Access: CLI auth without Access-app configuration

## Status

**Implemented (2026-07-06), including the plan below.** Login relays the verified Access
JWT to the CLI as `cf_token`; the CLI stores it in auth.json and sends it back as
`cf-access-token` on API requests (which both Cloudflare's edge and the server accept);
`SCRATCHWORK_CF_ACCESS_CLIENT_ID`/`SECRET` attach service-token headers for CI; edge
blocks fail with a re-auth prompt. The `/api/*` bypass policy is now optional, documented
as a fallback for older CLIs. Remaining manual step: verify against a real
Access-protected deploy.

The server-side `cloudflare-access` auth mode is implemented (see `server/README.md`
"Cloudflare Access"): `SCRATCHWORK_AUTH=cloudflare-access` makes the server verify the
`Cf-Access-Jwt-Assertion` header Cloudflare injects — RS256 signature against the team
JWKS, issuer, AUD tag, expiry — and use the asserted email as the identity. Browser
auth is transparent; `scratchwork login` works because `/auth/login` converts the
browser's verified assertion into the CLI's bearer token.

The gap: the CLI's **API requests** (`publish`, `share`, ...) carry only the bearer
token, so Cloudflare's edge blocks them before they reach the server. Today the README
tells admins to work around this with an Access bypass policy for `/api/*` or by having
users authenticate with `cloudflared`. This plan removes that requirement.

## Prior art

`~/git/scratch/scratch` (the earlier scratch implementation) solved this; its approach
is the model, with corrections:

1. **CF JWT relay**: during CLI login, its server reads the browser's
   `Cf-Access-Jwt-Assertion` and passes it to the CLI loopback callback as `cf_token`
   (`server/src/routes/app/ui.ts:114`). The CLI stores it and sends it back as a
   `cf-access-token` header on every API request (`cli/src/cloud/request.ts:199`).
   Cloudflare's edge accepts that header as an Access credential, so CLI requests pass
   the edge with **zero Access-application configuration**.
2. **Service tokens** for CI: stored CF-Access-Client-Id/Secret headers; the edge
   validates them and lets requests through.
3. **Edge-block detection**: 403 + `cf-mitigated` header, or HTML with Cloudflare
   Access markers where JSON was expected, triggers a friendly re-auth prompt
   (`cli/src/config/cf-access.ts:111-147`).

One mistake there we must not copy: its JWT verification checks the issuer but **not
the audience** (`server/src/lib/cloudflare-access.ts:41`), so a JWT minted for any
other Access application in the same team validates. Our `cloudflare-jwt.ts` enforces
the AUD tag; keep that in every new acceptance path.

## Plan

### 1. Server: relay the CF JWT to the CLI at login

`server/core/src/auth.ts`, `makeCloudflareAccessAuth` → `login`:

- When `cli_redirect` is present (already validated loopback-only by
  `safeCliRedirect`), add `cf_token=<raw Cf-Access-Jwt-Assertion header value>` to the
  redirect alongside the existing `token`/`server`/`email` params.
- Relay the raw header only after `assertedUser` verified it (it already has, by the
  time login mints the bearer token).
- The token rides a loopback query string exactly like the existing bearer token —
  same exposure class, no new precedent.

### 2. Server: accept the JWT from the `cf-access-token` header

`server/core/src/auth.ts`, `assertedUser`: read `cf-access-jwt-assertion` first, then
fall back to `cf-access-token`. Verification is identical (signature, issuer, AUD,
expiry — `verifyCloudflareAccessToken`), so this adds no trust; it only matters when a
request reaches the origin without passing through Cloudflare (grey-clouded origin,
local testing, migration). When the request does go through the edge, Cloudflare
validates `cf-access-token` itself and injects `Cf-Access-Jwt-Assertion` anyway.

Non-goal: reading the `CF_Authorization` cookie (the scratch repo does). Browser
requests always come through the edge, which injects the header; the cookie path adds
surface without a use case here.

### 3. CLI: store and send the CF token

- `cli/src/auth.ts`:
  - `AuthRecord` gains optional `cfToken` (auth.json stays `version: 1`; the field is
    optional, so old files and old CLIs are unaffected).
  - `LoginCallback` and `decodeLoginCallback` read `cf_token`.
  - `writeAuthToken` persists it; add `readCfToken(server)` using the same
    `candidateServers` origin fallback as `readAuthToken`.
- `cli/src/commands/login.ts`: pass `cfToken` through to `writeAuthToken`.
- `cli/src/api.ts`: `apiRequest` resolves the CF token itself from the request URL's
  origin (via `readCfToken`) and sets the `cf-access-token` header when one is stored.
  `readAuthToken` keeps returning the bearer string, so its ~11 call sites across
  `commands/publish.ts` and `commands/projects.ts` are untouched; the only ripple is
  that `apiRequest`/`apiJson` now require `FileSystem | Path` in their Effect context,
  which every caller already provides.

### 4. CLI: detect Cloudflare edge blocks and fail helpfully

In `apiRequest` (`cli/src/api.ts`), before generic error handling:

- **Denied**: status 403 with a `cf-mitigated` response header → CliError:
  "Cloudflare Access blocked this request. Run `scratchwork login` again (your Access
  session may have expired), or set SCRATCHWORK_CF_ACCESS_CLIENT_ID/SECRET for
  automation."
- **Login page**: response body is HTML containing Access markers
  (`cloudflareaccess`, `CF_Authorization`, ...) where JSON was expected — covers the
  302-to-login-page case after redirect following. Hook this into both the non-ok
  branch and the JSON-parse-failure branch, mirroring
  `scratch/cli/src/cloud/request.ts:264,296`.
- No automatic retry loop (the scratch repo prompts interactively mid-request; our
  CLI's commands are non-interactive by design) — one clear error with the fix is
  enough.

### 5. CLI: service tokens for CI/headless

Env vars only (no new credential file):

- `SCRATCHWORK_CF_ACCESS_CLIENT_ID` / `SCRATCHWORK_CF_ACCESS_CLIENT_SECRET`, attached
  by `apiRequest` as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers when
  both are set.
- No server change needed: the edge validates the service token and lets the request
  through; the service-token JWT it injects has no email, but `requireApiUser` checks
  the bearer token first, so the bearer still identifies the user. (Server-side
  service-token identities remain unsupported — authorization is email-based.)

### 6. Docs

- `server/README.md` Cloudflare Access section: the `/api/*` bypass policy becomes
  optional ("if you prefer not to relay Access tokens" / older CLIs) instead of
  required; document the env vars and the Access session-duration recommendation.
- `notes/spec.md` "Authenticating": mention the relay and the `cf-access-token`
  header.

## Caveats and decisions

- **CF token lifetime**: the relayed JWT expires with the Access application's session
  duration (default 24h, configurable to weeks) — much shorter than the 30-day bearer
  token. When it expires the edge blocks the CLI, which now fails with "run
  `scratchwork login` again" (step 4). Recommend a long Access session duration in the
  README; service tokens are the answer for automation.
- **No refresh path**: we deliberately don't try to refresh the CF token outside a
  browser (that is Cloudflare's login flow, not ours). Re-login is the refresh.
- **Compatibility**: old CLI + new server ignores `cf_token` (still needs the bypass
  policy, as today). New CLI + old server sees no `cf_token` and behaves exactly as
  today. New CLI + oauth server: no `cf_token`, nothing attached.
- **AUD check stays** in every path that verifies an Access JWT (see "Prior art").

## Testing

- `server/core/test/auth.test.ts`: login relay — CF-mode login with `cli_redirect`
  includes `cf_token` equal to the presented assertion; oauth-mode login never does.
  `cf-access-token` header accepted by `currentUser`/`requireApiUser`;
  `cf-access-jwt-assertion` wins when both are present; invalid values still rejected.
- `cli/test`: `decodeLoginCallback` with/without `cf_token`; auth.json round-trip with
  `cfToken` and old-file compatibility; `apiRequest` attaches `cf-access-token` and
  service-token headers; edge-block detection on a fake 403 + `cf-mitigated` and on an
  HTML body.
- Manual: local server in CF mode (JWT via test JWKS) exercising login → publish with
  the relayed token; a real Access-protected deploy for the edge behavior.
