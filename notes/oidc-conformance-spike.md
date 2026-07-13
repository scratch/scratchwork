# Spike: OpenID Foundation RP conformance suite for Scratchwork

Phase 3 of `improve-harness-plan.md` calls for three OAuth/OIDC test layers. The
hermetic provider and the full-loop lanes exist (`e2e/`); this note is the spike
for the second layer — running the [OpenID Foundation conformance
suite](https://openid.net/certification/about-conformance-suite/) as an
adversarial *provider* against Scratchwork's relying-party (RP) implementation —
with the concrete automation plan and the gaps that must close before it can
join `bun run ci`.

## What the suite is and how it runs locally

The conformance suite is a Java service (plus MongoDB) published by the OpenID
Foundation; it runs locally with Docker Compose per the [project
docs](https://gitlab.com/openid/conformance-suite) ("Developers > Run locally").
For RP testing the suite plays the OP: each test module exposes its own
issuer/authorization/token/JWKS endpoints and misbehaves in a controlled way
(wrong `iss`, tampered signatures, reused `state`, missing `exp`, …). The RP
under test is certified by completing a plan such as
`oidcc-client-basic-certification-test-plan` (Basic RP profile: authorization
code flow).

Two properties make it automatable:

1. **REST API.** Plans and test modules are created and polled over HTTP
   (`/api/plan`, `/api/runner`, `/api/log`), so a runner script can create the
   plan, iterate modules, and read PASS/WARNING/FAIL verdicts without the UI.
2. **RP driving.** Each module waits for the RP to start a flow. Scratchwork's
   flow is started by `GET /auth/login` and completed by following redirects —
   exactly what `e2e/src/harness.ts`'s `Browser` already does for the hermetic
   provider.

## Wiring Scratchwork to the suite

The loopback-gated `SCRATCHWORK_LOCAL_OAUTH_{AUTHORIZE,TOKEN,JWKS}_URL`
overrides added in phase 3 point the server at any local OP, so most of the
plumbing already exists. The spike found these concrete gaps:

- **Issuer check is hardcoded to Google.** `server/core/src/google-jwt.ts`
  accepts only `https://accounts.google.com` / `accounts.google.com` as `iss`.
  The conformance OP issues under its own URL. Needed: an expected-issuer field
  alongside the local endpoint overrides (same loopback gating), defaulting to
  Google. Without it every module fails at ID-token validation for the wrong
  reason.
- **Client authentication variant.** Scratchwork sends `client_id` +
  `client_secret` in the token-request body → variant
  `client_auth_type=client_secret_post`, `response_type=code`,
  `response_mode=default`. The suite must be configured with the same static
  client (`e2e` client id/secret) since Scratchwork does not do dynamic
  registration.
- **Claim requirements.** Scratchwork requires `email` and
  `email_verified === true`. The certification modules do not all include email
  claims; the suite's client configuration must request/seed an email for the
  test user, or the affected modules will fail on Scratchwork's (deliberate)
  extra strictness. This is configuration, not a code change — the strictness
  is the point.
- **One flow per module, sequentially.** Each module needs a fresh browser
  transaction; the runner must not reuse state cookies across modules (a fresh
  `Browser` per module, as the negative-lane tests already do).

## Runner shape (next implementation step)

`e2e/conformance/run.ts` (not part of `bun test`; its own entry):

1. `docker compose up` the suite (pin the suite release tag; it ships
   `builds/` images) with MongoDB, wait for `/api/server` health.
2. `POST /api/plan?planName=oidcc-client-basic-certification-test-plan` with a
   JSON config naming the static client and Scratchwork's redirect URI
   (`http://localhost:<port>/auth/callback/google`).
3. For each module in the plan: create the runner, start a local Scratchwork
   (`deploy/local-dev` entrypoint, local endpoint overrides pointed at the
   module's issuer), drive `GET /auth/login` with the harness `Browser`, poll
   the module until `FINISHED`, record the verdict.
4. Exit nonzero unless every module is PASS or WARNING (warnings printed).

Runtime estimate: ~30 modules × one full flow each — minutes, not seconds,
plus the suite images. That is fine for a required lane but heavier than the
rest of `bun run ci`.

## Gate plan

Per `improve-harness-plan.md`, conformance coverage is **required before
launch** and belongs in `bun run ci` rather than staying a manual lane. Order
of work:

1. Add the loopback-gated expected-issuer override (small; unblocks everything).
2. Land `e2e/conformance/run.ts` + suite compose file, runnable on demand
   (`bun run conformance` in `e2e/`).
3. Once green and timed, wire it into `e2e`'s `ci` script. If measured runtime
   is a real problem, split per the plan's rule: a separate required pre-merge
   gate, never quietly optional.

## Third layer reminder (not automated)

Real-provider smoke stays manual by design: a separate Google Cloud testing
project and dedicated test users, exercised before releases and whenever scopes
or provider configuration change ([Google's testing-project
guidance](https://support.google.com/cloud/answer/13464018)). Automated Google
UI login must not become a PR dependency.
