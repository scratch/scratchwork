# OIDC RP conformance: OpenID Foundation suite against Scratchwork

Phase 3 of `improve-harness-plan.md` calls for three OAuth/OIDC test layers. The
hermetic provider and the full-loop lanes exist (`e2e/`); this note covers the
second layer — the [OpenID Foundation conformance
suite](https://openid.net/certification/about-conformance-suite/) run locally in
Docker as an adversarial *provider* against Scratchwork's relying-party (RP)
implementation. The lane is **implemented and was run for real** (2026-07-20,
suite `release-v5.2.0`): `bun run conformance` in `e2e/` runs the
`oidcc-client-basic-certification-test-plan`, scoped by decision (bottom of this
note) to the seven modules that judge the RP by *rejecting* tampered ID tokens.

## What landed

- **Expected-issuer override.** `SCRATCHWORK_LOCAL_OAUTH_ISSUER`, accepted only
  together with the loopback-gated `SCRATCHWORK_LOCAL_OAUTH_*` endpoint overrides
  (`server/core/src/config.ts`). It replaces — never widens — the Google issuer
  check in `google-jwt.ts`, and is only an expected-claim string, never fetched,
  so it may name the suite's non-loopback issuer URL.
- **client_secret_basic.** The token-endpoint client authentication moved from
  `client_secret_post` (credentials in the form body) to `client_secret_basic`
  (RFC 6749 §2.3.1 Authorization header) in `postAuthorizationCodeGrant`. The
  basic RP plan validates client auth with
  `ExtractClientCredentialsFromBasicAuthorizationHeader` at FAILURE level, so
  `client_secret_post` fails *every* module at the token endpoint; basic is also
  the scheme RFC 6749 requires servers to support, and Google supports it. The
  hermetic e2e provider now requires the basic header and rejects any
  `client_secret` in the body, so a regression fails the ordinary e2e lanes.
- **The lane itself.** `e2e/conformance/docker-compose.yml` (prebuilt suite
  images pinned to `release-v5.2.0`; devmode, so the runner needs no API token)
  and `e2e/conformance/run.ts` (suite lifecycle, REST driving via
  `/api/plan` → `/api/runner` → `/api/runner/{id}/wait-state` → `/api/info/{id}`,
  one fresh local-dev Scratchwork + fresh browser per module, per-module verdict
  table). A loopback HTTP proxy inside the runner fronts the suite's
  per-alias HTTPS endpoints, because the `SCRATCHWORK_LOCAL_OAUTH_*` overrides
  deliberately accept only literal-loopback plain-HTTP URLs and the suite serves
  HTTPS under `localhost.emobix.co.uk` (public DNS for 127.0.0.1) with a
  self-signed certificate. TLS verification is disabled only inside the runner —
  test infrastructure talking to a local container — never in product code.

## Verified results (2026-07-20, suite release-v5.2.0)

Every module the RP judges by *rejecting* a tampered ID token passes; every
module that requires *completing* a login against the suite's OP stalls:

| Module | Result |
|---|---|
| oidcc-client-test-invalid-iss | PASSED |
| oidcc-client-test-missing-sub | PASSED |
| oidcc-client-test-invalid-aud | PASSED |
| oidcc-client-test-missing-iat | PASSED |
| oidcc-client-test-kid-absent-multiple-jwks | PASSED |
| oidcc-client-test-invalid-sig-rs256 | PASSED |
| oidcc-client-test-nonce-invalid | PASSED |
| oidcc-client-test-idtoken-sig-none | SKIPPED (expected: we reject `alg=none`) |
| oidcc-client-test | stuck WAITING → aborted |
| oidcc-client-test-kid-absent-single-jwks | stuck WAITING → aborted |
| oidcc-client-test-idtoken-sig-rs256 | stuck WAITING → aborted |
| oidcc-client-test-userinfo-invalid-sub | stuck WAITING → aborted |
| oidcc-client-test-scope-userinfo-claims | stuck WAITING → aborted |
| oidcc-client-test-client-secret-basic | stuck WAITING → aborted |

That baseline run of the full plan: 8/14 green (7 PASSED + the expected
SKIPPED). Following the decision below, the lane's required set is now exactly
the seven PASSED modules.

## Why the six stall — findings the original spike got wrong

Verified against the suite sources (release-v5.2.0):

1. **The suite's OP never puts email in the ID token.** For the code-flow plan
   the ID token carries only `iss, sub, aud, nonce, iat, exp`
   (`GenerateIdTokenClaims.java`). Email claims are served **only by the
   userinfo endpoint** when the `email` scope is requested, and the test user is
   **hardcoded** with `email_verified=false` (`OIDCCLoadUserInfo.java`) — there
   is no configuration mechanism to change the user's claims. The original
   spike's assumption that "the suite's client configuration must request/seed
   an email for the test user" is wrong.
2. **Positive modules finish only after a userinfo request.** With
   `response_type=code`, `oidcc-client-test` (and the other positive modules)
   fire FINISHED only once the RP calls userinfo
   (`finishTestIfAllRequestsAreReceived`). Scratchwork never calls userinfo, and
   it rejects the email-less ID token anyway ("ID token is missing email"), so
   these modules wait forever; the runner aborts them after 60s.
3. **`kid` handling.** `jwt-rs256.ts` requires a `kid` in every token header.
   OIDC Core §10.1 allows omitting `kid` when the JWKS holds a single key, which
   is exactly what `oidcc-client-test-kid-absent-single-jwks` exercises — even
   with the email/userinfo gap closed, this module needs the verifier to accept
   a kid-less token when the JWKS has exactly one RSA signing key. (The
   multiple-keys variant passes: rejecting is allowed there.)
4. **Negative modules self-finish.** After serving a tampered token, the suite
   waits `waitTimeoutSeconds` (we set 5s); RP silence is scored as a correct
   abort — no runner intervention needed. An RP that wrongly proceeds to
   userinfo is FAILED (or SKIPPED for the token-endpoint-delivered
   invalid-signature case, which OIDC Core tolerates).

## Decision (Pete, 2026-07-20): keep the RP as is; require only the rejection modules

Greening the six stalled modules would have required adding a userinfo request
to the production login flow, a second identity-claims source reconciled with
the ID token, and a live bearer access token (today the ID token is the *only*
credential Scratchwork consumes — the access token is ignored). Google never
exercises any of that (it always sends `kid` and a verified email in the ID
token), so it would be permanently dead code in the auth core whose only caller
is the conformance suite — inverting the harness's purpose. The stalled modules
measure conformance to a generic multi-provider RP profile, not resistance to
attack; the modules that matter for security all pass.

Accordingly the lane's required assertion set is the **seven
tampered-token-rejection modules** (`REQUIRED_MODULES` in
`e2e/conformance/run.ts`); the other seven are **not-applicable-by-design**, not
aspirational — the runner skips them and logs the skip. This narrows the plan's
original "conformance coverage required before launch" from certification-green
to security-modules-green, deliberately. Formal OpenID certification is off the
table unless the product decision above is revisited.

(`oidcc-client-test-idtoken-sig-none` — the RP refusing an `alg=none` token,
recorded by the suite as SKIPPED — is also excluded from the required set, but
the equivalent guarantee is pinned locally: `jwt-rs256.ts` accepts only RS256,
and the token corpus + hermetic-provider lanes cover algorithm confusion.)

## Operational notes

- First run pulls ~2GB of images; the suite (amd64 images, emulated on Apple
  Silicon) takes a few minutes to boot. The runner starts the stack if it is not
  already healthy and tears it down afterwards unless `CONFORMANCE_KEEP_SUITE`
  is set (keep it up while iterating; the suite UI at
  https://localhost.emobix.co.uk:8443 shows per-module logs).
- The prebuilt image splices `JAVA_EXTRA_ARGS` in *before* `-jar`, so devmode
  must be passed as `-Dfintechlabs.devmode=true` (the Spring `--flag` form only
  works in the suite's own source-build compose).
- `localhost.emobix.co.uk` resolves to 127.0.0.1 in public DNS; the runner
  connects to 127.0.0.1 directly so DNS-rebind-protective resolvers don't break
  it.

## Third layer reminder (not automated)

Real-provider smoke stays manual by design: a separate Google Cloud testing
project and dedicated test users, exercised before releases and whenever scopes
or provider configuration change ([Google's testing-project
guidance](https://support.google.com/cloud/answer/13464018)). Automated Google
UI login must not become a PR dependency.
