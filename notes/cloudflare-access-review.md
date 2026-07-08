# Code review: cloudflare-access branch

Review of the five commits on `cloudflare-access` vs `origin/main` (~2,600 lines across 57
files): the Cloudflare Access auth mode, the CLI token relay, and the local Cloudflare
worker deployments.

**Overall**: a well-built branch. The JWT verification is careful (alg/kid/crit checks,
clock skew, service-token rejection, key caching), the local Access simulator is cleanly
isolated from production entry points, and the test suite passes (298/0). Findings are
ranked most-severe first: 1–2 are worth fixing before merge, 3–8 deserve a decision,
9–10 are polish.

## 1. `requireApiUser` hard-fails on an invalid bearer instead of falling back to a valid Access assertion — FIXED

Fixed 2026-07-07: `verifySessionToken` is now wrapped in `Effect.orElseSucceed(() => null)`
in the cloudflare-access `requireApiUser`, matching `currentUser`; regression test added
("a stale bearer token falls back to a valid Access assertion").

`server/core/src/auth.ts:341` — in cloudflare-access mode, `requireApiUser` propagates a
bearer-signature verification failure instead of falling through to the Access assertion,
unlike `currentUser` (line 330–335), which wraps `verifySessionToken` in `orElseSucceed`.

Failure: operator rotates `SCRATCHWORK_SESSION_SECRET`. The CLI still sends its stale
bearer token plus a fresh, valid `cf-access-token` header. `verifySessionToken` fails with
`AuthError` before `assertedUser(request)` is ever tried, so every API call 401s even
though the same request *without* the bearer would authenticate. Browser requests via
`currentUser` keep working; the CLI is locked out until manual re-login. (Expired tokens
return null and fall through correctly — only signature-invalid tokens hit this.)

## 2. Relayed Access JWT is never found for path-mounted servers

`cli/src/api.ts:108` — `readCfToken` is keyed by bare URL origin, but auth.json records
are keyed by `normalizeServerUrl` output, which preserves a path prefix.

Failure: user logs into a path-mounted server (`scratchwork login --server
https://host/scratchwork` — a shape `serverApiUrl` explicitly supports) behind Cloudflare
Access. `writeAuthToken` stores the cfToken under `"https://host/scratchwork"`, but
`attachCloudflareAccess` looks up `readCfToken("https://host")` and `candidateServers`
never yields the path-prefixed key — so `cf-access-token` is never attached, every request
is edge-blocked, and the CLI loops on "re-run scratchwork login" immediately after a
successful login.

## 3. Service-token secret is sent to every origin

`cli/src/api.ts:113` — the `SCRATCHWORK_CF_ACCESS_CLIENT_ID/SECRET` headers are attached
to every `apiRequest` regardless of target origin.

Failure: CI sets the service-token env vars for its corp server; any command addressed at
a different server (`scratchwork publish --server https://other.example`) sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret` to that third party. The stored
cfToken is origin-scoped, but the service token is not — scope it to a configured origin
(e.g. `SCRATCHWORK_CF_ACCESS_SERVER`) or at least to the logged-in server.

## 4. Unknown-kid tokens trigger an unauthenticated JWKS fetch per request

`server/core/src/jwt-rs256.ts:130` — `getJwksKey` performs a network JWKS refresh on
every unknown-kid token with no negative caching or cooldown, and in cloudflare-access
mode this path is reachable by unauthenticated requests.

Failure: `assertedUser` verifies any client-supplied `cf-access-token` header before
authentication. An attacker sends well-formed RS256 JWTs with random `kid` values: each
request misses the cache and triggers a full fetch of the team JWKS URL (5s timeout,
whole-set key re-import) — one outbound subrequest per attacker request, burning Worker
subrequest limits and hammering the JWKS endpoint. Add a short negative-result cooldown
per jwksUrl.

## 5. Edge blocks bypass publish's auto-login retry

`cli/src/api.ts:61` — a Cloudflare edge block becomes a plain `CliError`, so publish's
`PublishAuthRequired` auto-login retry never fires for Access-protected servers.

Failure: user with an expired (or absent) Access session runs `scratchwork publish`: the
edge returns the Access login page, `apiRequest` fails with a generic `CliError` instead
of the 401 → `PublishAuthRequired` path (`cli/src/commands/publish.ts:82`), so the
automatic runLogin-and-retry flow that oauth servers get is skipped and the command aborts
telling the user to log in manually.

## 6. Local Cloudflare run inverts env-var precedence

`server/deploy-cloudflare/src/deploy.ts:211` — `runLocalCloudflareServer` spreads
config-derived vars after `loadedEnv.env`, inverting the established precedence where
shell `SCRATCHWORK_*` vars override the deploy project's server config
(`server/deploy-local/src/run.ts:105` uses `processEnv[key] ?? value`).

Failure: developer runs `SCRATCHWORK_ALLOWED_USERS=@myco.com bun run local:sndbx.sh`:
server-config.ts's `allowedUsers` silently wins because `localServerEnv` is spread after
`loadedEnv.env`, so the local server accepts logins from any account despite the explicit
shell override — no warning, and the two local runners now disagree on precedence.

## 7. Local sndbx.sh run hard-requires a `.env` file

`deploy/sndbx.sh/local.ts:6` — the local run passes `envFile: ".env"`, which reaches
`readExplicitEnvFile`, and that throws when the file is absent.

Failure: developer with all secrets exported in their shell but no `deploy/sndbx.sh/.env`
file runs `bun run local:sndbx.sh`: `loadDeployEnv` throws `Env file not found: .env`
(`server/scripts/env.ts:112`) and the server never starts, where the previous
`runLocalServer` path worked from shell env alone.

## 8. WAF challenges are misclassified as Access blocks

`cli/src/api.ts:136` — `edgeBlocked` treats any 403 carrying a `cf-mitigated` header as a
Cloudflare Access block, but `cf-mitigated` is also set by Cloudflare WAF/bot challenges
on servers with no Access application.

Failure: a server behind ordinary Cloudflare gets a WAF bot challenge: 403 with
`cf-mitigated: challenge`. `apiRequest` converts this into a hard `CliError` advising
"run scratchwork login again" and setting Access service-token vars — advice that cannot
fix a WAF challenge — and callers never see the response to interpret the 403 themselves.

## 9. Renderer: empty-destination image inside a link label no longer parses as a link

`renderer/src/render.js:61` — `INLINE_IMAGE`'s destination changed from the old
`[^()\s]*` (empty allowed) to `DEST_BODY` with a `+` quantifier.

Failure: markdown `[![CI]()](https://ci.example.com)` (badge with a placeholder image
URL): origin/main rendered a working link wrapping the literal image text; the new
renderer emits literal `[![CI]()](` plus an autolinked URL and `)`, silently breaking the
link.

## 10. Duplicated team-domain normalization and kid constant in the local simulator

`server/deploy-cloudflare/src/local-worker.ts:91` — `normalizedTeamDomain` hand-copies
config.ts's private `normalizeCfTeamDomain` (its docstring admits it "mirrors" it), and
the simulator kid string `"scratchwork-local-access"` is independently hardcoded here and
in `server/deploy-cloudflare/src/deploy.ts:454`.

Cost: the simulator's signed `iss` claim must byte-match what
`server/core/src/config.ts:325` computes for the verifier; the copies already diverge
(config validates via `safeDomain` and can return null; the mirror silently produces an
invalid origin). The next normalization change lands in one file and every locally
simulated request fails with "Invalid Access token issuer" — export
`normalizeCfTeamDomain` from server-core (local-worker already imports server core) and
share the kid constant.

## Verification notes

Findings 1, 2, 5, 6, 7, 9 are confirmed directly against the code (each failure path
traced by hand); 3, 4, 8 are plausible-by-construction (real reachable states, severity
depends on deployment shape); 10 was independently flagged by three finder angles. One
candidate was refuted during verification: a suspected missing `await` on `worker.fetch`
in local-worker.ts is harmless because the production worker's `fetch` wraps its body in
`try { return await … } catch` and its promise never rejects.

Review run 2026-07-07 against `origin/main...HEAD` (`ad45683`), 8 finder angles plus a
recall-biased verify pass; full test suite passing at time of review (298 pass, 0 fail).
