# Review: PR #19 — Phase 3 full-loop publish e2e + code+PKCE CLI handoff

Reviewed at head 355ff39. Four parallel review passes (server auth, CLI auth, e2e harness,
test suites/CI) plus an independent reviewer's findings, with the top findings re-verified
directly against the code.

## Overview

The PR does what it says, and does most of it very well. The CLI login handoff is
redesigned from token-in-query to an RFC 8252/9700-style flow: the CLI generates a PKCE
verifier + state, the server mints a signed 60-second one-time `cli-code` bound to the
S256 challenge and exact redirect URI, and the CLI redeems it via back-channel
`POST /auth/cli/token` with atomic replay burning. A new `e2e/` workspace drives the real
CLI binary against real server subprocesses across three backends (local-dev,
Worker-under-miniflare, Lambda-against-LocalStack), fed by a hermetic real-HTTP OAuth
provider, plus a suite of auth-negative lanes.

The core security machinery is correct and unusually well-tested: the replay burn is
genuinely atomic in production backends (DynamoDB conditional put, D1 unique-constraint
insert), HMAC/state/challenge comparisons are timing-safe, the state cookie is
HttpOnly/SameSite=Lax/`__Host-`-prefixed with the provider-leg verifier kept cookie-only,
`safeCliRedirect` is strictly RFC 8252 loopback, and the CLI's loopback listener handles
state gating, path confusion, duplicate callbacks, and teardown correctly. The
intercepted-code e2e test is falsifiable in both directions (removing either PKCE
verification or code burning fails it).

That said, there are two findings that break or undermine the flow in Cloudflare Access
mode, one origin-handling regression, and three test-fidelity gaps worth fixing before
merge.

## Major findings

### 1. [P1] First-time (and post-expiry) Cloudflare Access logins cannot complete — the back-channel exchange is itself blocked by the Access edge

The redesign's back-channel `POST /auth/cli/token` must traverse the Access-protected app
hostname, but the CLI only attaches Access credentials it already has:
`attachCloudflareAccess` (`cli/src/api.ts:105-118`) sends a `cf-access-token` read from
the auth file — which is populated only by a *previous* successful login
(`writeAuthToken(..., result.cfToken)`, `cli/src/commands/login.ts:57`) — or
service-token headers from `SCRATCHWORK_CF_ACCESS_CLIENT_ID/SECRET`. On first login there
is nothing to send, so the Access edge blocks the exchange before it reaches the Worker,
and the exchange is the only mechanism for acquiring the cfToken. The same deadlock
recurs whenever the stored Access JWT expires (Access sessions are hours/days). The old
token-in-query flow had no back-channel leg, so it didn't have this dependency. The
hermetic tests run without a real Access edge and structurally cannot catch it.

**Fix options:** exempt `/auth/cli/token` from the Access application (edge config +
documentation), or relay the Access JWT through a channel that doesn't need the edge.
Best solved jointly with finding 2 (e.g. an Access bypass policy on the exchange path
plus a server-side cfToken stash keyed by code id satisfies both).

### 2. [P1] The Cloudflare Access JWT is recoverable from the authorization code itself — reintroducing the query-string credential leak this PR exists to eliminate

`server/core/src/auth.ts:452-459` embeds the verified Access JWT as `cfToken` inside the
`cli-code` payload, and `signValue` (`auth.ts:751`) produces
`base64url(JSON) + "." + HMAC` — signed, **not encrypted**. That code rides the loopback
redirect query string (`?code=...`), so anyone who can read the URL (browser history,
history sync, local request logs) can base64url-decode the first segment and extract the
JWT without redeeming the code — no PKCE verifier needed, no redemption burn triggered,
and the 60-second code expiry is irrelevant because the embedded JWT stays valid for the
Access session (hours). The stolen JWT authenticates directly via the `cf-access-token`
header (`auth.ts:350-360`). The comment at `auth.ts:448-451` claiming the JWT "stays out
of the query string" is false, and the tests only assert there's no *separate* `cf_token`
query param.

**Fix:** stash the cfToken server-side keyed by the code's `id` (PrimitiveDb is already a
route dependency) and return it only from the back-channel exchange, or encrypt the code
payload. Coordinate with finding 1: a server-side stash is only reachable if the exchange
endpoint is reachable.

### 3. [P2] `scratchwork login <content-or-homepage-origin>` breaks: the code exchange targets the original origin, which 302s all `/auth/*` to the app origin

`handleRequest` canonicalizes every `/auth/*` path, including `/auth/cli/token`, with a
302 to the app origin when the request arrives on a non-app origin
(`server/core/src/app.ts:89-92, 923-933`). The browser leg survives this (GET follows the
redirect), but the CLI's exchange POST at `cli/src/commands/login.ts:126` targets
`serverApiUrl(server, ...)` with the user-typed origin — `normalizeServerUrl` only cleans
the string into an origin, it doesn't resolve to the app origin. A 302 on a POST either
isn't followed (non-2xx → `apiJson` fails) or is re-issued as a GET per fetch semantics
(→ 405). Notably the exchange *response* already carries a canonical `result.server` for
exactly this origin-mismatch situation (`login.ts:53-56`) — but that arrives only after a
successful exchange, too late to help. This worked with the previous callback flow, which
had no back-channel POST.

**Fix:** resolve the canonical app origin before the exchange (e.g. via the existing
`/api/resolve`, or have the loopback callback carry the app origin the code was minted
on), or make the server accept the exchange POST on any origin it serves.

Findings 1 and 3 share a root cause worth noting: the move to a back-channel exchange
implicitly assumed the exchange endpoint is reachable exactly like the old query-string
delivery was — but the old delivery rode the browser (which had the Access session and
follows redirects), while the new POST rides the bare CLI HTTP client, which has neither.
Any fix should be validated with a lane that simulates the edge (even a minimal reverse
proxy that 403s requests lacking the Access header would have caught finding 1).

### 4. Expired project-access/handoff tokens have zero test coverage — and two places in the diff claim otherwise

`e2e/test/auth-negative.test.ts:231-233` and `notes/improve-harness-plan.md:60` both say
expiry is "covered at the unit level," but the only expiry test in `server/core/test/` is
for CLI codes (`app.test.ts:1243`); the `verifyProjectAccessToken` tests cover
wrong-project and wrong-purpose but not the `expiresAt` branch (`auth.ts:506`). Since the
e2e suite deliberately asserts handoff replay-within-lifetime *succeeds*, expiry is the
only control standing on handoff tokens — which land in proxy logs by the code's own
admission — and a regression dropping it would make them forever-replayable URL
credentials with nothing failing.

**Fix:** one unit test with the `Date.now` shim pattern already used at
`app.test.ts:1245-1250`, and correct both comments.

### 5. The hermetic OAuth provider emits email claims regardless of requested scopes

`e2e/src/oauth-provider.ts:130-142` only checks scope includes `openid` but
unconditionally embeds `email`/`email_verified`/`name`/`picture`. Real Google includes
email claims only when the `email` scope was granted. A refactor that trims the server's
authorization request to `scope=openid` keeps every e2e lane green while breaking
production logins. This is the one place the double is laxer than Google (elsewhere it's
stricter — mandatory PKCE/state/nonce, exact redirect URI, one-use codes).

### 6. The state-tampering test's "no code exchange happened" assertion is vacuous

`e2e/test/auth-negative.test.ts:142-148` snapshots `provider.authorizeRequests.length`
(misnamed `tokenRequestsBefore`) — but the provider records only `/authorize` hits, never
`/token` requests (`oauth-provider.ts:103`), so this assertion can't fail even if the
server exchanged the code before validating state. The primary 400 assertion is real, but
the ordering property the comment claims is unverified.

**Fix:** record token-endpoint requests in the provider and assert on those.

## Minor findings

### Server (`server/core/src/`)

- CLI-code redemption records never expire despite the comment saying they do — no
  DynamoDB TTL attribute, no D1/memory pruning (`app.ts` CLI_CODE_NAMESPACE;
  `deploy-aws/src/dynamodb-db.ts:202-204`). Every redemption attempt — including a failed
  one with a wrong verifier — permanently adds a record, so growth isn't even bounded by
  successful logins. Fail-safe direction, but unbounded.
- Session tokens lack a `kind` discriminator (`auth.ts:73-79`); a cli-code fails bearer
  verification only because it happens to lack `issuedAt`. Add `kind: "session"` or
  decode with `onExcessProperty: "error"` so cross-kind confusion is prevented by design,
  not accident.
- The loopback gate on `SCRATCHWORK_LOCAL_OAUTH_*` accepts `*.localhost` and `0.0.0.0`
  (`config.ts:260,273`); `foo.localhost` isn't guaranteed to resolve to loopback on all
  platforms, and this endpoint receives `client_secret`. Use the same narrow literal
  check as `safeCliRedirect`.
- Inconsistent statuses from `/auth/cli/token`: structurally invalid code → 401,
  expiry/mismatch/replay → 400. A uniform `invalid_grant`-style 400 would be more
  conventional (`auth.ts:624-627`).

### CLI (`cli/src/`)

- `scratchwork login` has no overall timeout (`login.ts:97`) — if the callback never
  arrives, it hangs forever. Pre-existing behavior, but the 60-second bound is
  server-side only.
- `exchangeSettled` is never settled on fiber interruption (`login.ts:104-107`), leaving
  a browser callback request pending; settle via `Effect.onExit` or use `stop(true)` in
  the release.
- Dead fallbacks `result.server ?? server` / `result.email ?? "user"` (`login.ts:54,58`)
  contradict the required-field schema in `shared/src/publish/api.ts` — reconcile one way
  or the other.
- Server-relayed `outcome.error` is printed verbatim to the terminal (ANSI-escape
  injection from a hostile server); cheap to sanitize/truncate.

### E2E harness (`e2e/src/`)

- Backend stderr isn't drained while waiting for the stdout ready banner
  (`harness.ts:307-313`) — a chatty backend (>64KB to stderr) deadlocks into a 90s
  timeout every run.
- The spawned login CLI isn't killed on assertion failure (`suite.ts:42-60`, also
  `startCliLogin` in auth-negative) — orphaned processes accumulate on persistent
  runners; wrap in try/finally.
- Fixed LocalStack container name `scratchwork-e2e-localstack` races across concurrent
  runs on one machine (`localstack.ts:8,44-66`); use a per-run name like the per-process
  bucket/table suffixes.
- Hardcoded `compatibilityDate: "2025-01-01"` (`servers/cloudflare.ts:51`) vs
  production's `2026-06-01` (`deploy-cloudflare/src/deploy.ts:336`) — the lane's purpose
  is exercising the production Worker; import the deploy default.
- The cookie jar ignores the `Domain` attribute and `Expires`-based deletion
  (`harness.ts:205-224`), so a buggy broad-`Domain` cookie would not violate the
  app/content isolation tests the way it would in a real browser.
- Provider authorization codes never expire (`oauth-provider.ts:113-114`); Google's
  expire in ~10 minutes.
- `scripts/each-workspace.ts:83` runs dependents after a *failed* blocker — a broken CLI
  still boots the whole e2e suite and produces a misleading cascade failure.

### Test assertions (`e2e/test/`, `e2e/src/suite.ts`)

- The revoke-denial oracle is `not.toBe(200)` (`suite.ts:207-209` and twice in
  auth-negative) — a 500 passes; assert the actual masked 403/404.
- The key-rotation test is positive-only; nothing anywhere rejects a token signed by a
  retired key. Also, JWKS is served with `cache-control: max-age=60`, which would make a
  future retired-key-rejected test flaky.
- The allow-list revocation test's oracle is substring-weak (`auth-negative.test.ts:276-278`):
  no exit-code assertion on the post-revocation `me` call, and `"false"` is matched
  against combined stdout+stderr.
- Six `expect(stderr).toBe("")` assertions (`suite.ts:58,141,172,186,201,221`) are a
  maintenance tripwire — any benign Bun warning breaks all lanes at once.
- Negative lanes run only against the local-dev backend — justifiable since auth lives in
  shared `server/core`, but worth a one-line comment stating it's deliberate.

### Nits

- E2E port bases (35100+i·300) interleave with the cli runner's ranges; safe today only
  because `each-workspace.ts` serializes e2e after cli. Carve truly disjoint ranges.
- `e2e/test/.build/worker-<port>/` bundles accumulate indefinitely.
- `renderer/build.js:59-60` hashes the entire root `bun.lock` into
  `defaultRendererSourceHash`, so any workspace's dep change dirties the renderer
  artifact — harmless churn.
- Missing failure-path tests: duplicate-valid-callback replay, malformed exchange
  response (CLI schema-decode path), `/auth/cli/token` error surface (GET→405, malformed
  JSON, oversized body), expired OAuth state cookie, `safeCliRedirect` rejection paths,
  and a full-route CF-mode exchange asserting `cfToken` in the response body.

## Verified as sound (explicit non-findings)

- Replay burn is atomic in all three backends; burn-before-verify ordering fails closed;
  the allow-list is re-checked at redemption so revocation beats a just-issued code.
- The CLI loopback implementation is textbook RFC 8252: correct entropy (43-char
  verifier, 128-bit state), loopback-only binding, exact path/state gating,
  first-callback-wins, back-channel-only token delivery, scoped teardown on all paths.
- `shared/src/site/default-renderer.generated.js` is a legitimate regeneration —
  byte-compared: only the source hash changed (it covers `bun.lock`, which the new
  workspace touches), and `scripts/check-generated-fresh.ts` forces the commit.
- CI wiring is real: `e2e` is in the root workspaces list, ordering
  `renderer → cli → e2e` is enforced pre-pool-slot, and
  `CI=true SCRATCHWORK_E2E_SKIP_AWS=1` was verified to exit 1.
- The intercepted-code test (`auth-negative.test.ts:99-133`) is genuinely non-vacuous in
  both directions; the session-cookie-on-content-host and cross-project-cookie tests are
  real token-confusion checks; the wrong-nonce and malformed-token-response 401
  assertions are non-vacuous; the JWKS rotation test is deterministic, not cache-flaky.
- `notes/oidc-conformance-spike.md` claims check out: the Google-issuer hardcode it flags
  is real (`google-jwt.ts:61`), and the loopback gating of `SCRATCHWORK_LOCAL_OAUTH_*`
  has the config test it claims.
- All local-dev and auth-negative lanes pass locally.

## Verdict

**Request changes.** The blocking set:

1. **Finding 1 (P1):** CF Access first-time login is deadlocked — the flow's primary
   purpose fails in that deployment mode.
2. **Finding 2 (P1):** the Access JWT is recoverable from the code in the query string —
   and its fix must be designed jointly with finding 1.
3. **Finding 3 (P2):** login from a content/homepage origin regresses versus the old
   flow.
4. **Finding 4:** expired handoff-token coverage is absent while two comments in the diff
   claim it exists.

Findings 5-6 (provider scope laxness, vacuous no-exchange assertion) are strongly
recommended pre-merge; everything else can follow up. The overall design and
craftsmanship are excellent — the state-cookie/opaque-param split, dual-leg PKCE, and
falsifiable negative tests are well above the bar for this kind of work.
