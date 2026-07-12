# Keeping the codebase healthy: harness + invariants

**Goal:** a multi-pronged approach to keeping this codebase healthy as it changes:

1. one command that exercises everything that matters, run automatically on every PR;
2. a registry of invariants — things that must remain true about the codebase — that agents (Claude, Codex, OpenCode) verify against every change, and that graduate into mechanical checks over time.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

## Where we are today

**Test suites that exist:**

| Area | Suite | What it covers |
|---|---|---|
| renderer | `renderer/test/*.test.js` | Parser + render output (no browser) |
| cli | `cli/test/{api,auth,help,components}.test.js` | Units vs real loopback HTTP |
| cli | `cli/test/e2e.test.js` (~1,500 lines) | Real e2e for `scratchwork dev` |
| server | `server/core/test/*` | Core app via in-memory handler |
| server | `server/deploy-{aws,cloudflare}/test/*` | Deploy-target adapters |
| server | `server/scripts/*.test.ts` | Deploy tooling |

**Root scripts are inconsistent — no single command runs everything:**

- `bun run test` → renderer + cli only (misses server, deploy targets)
- `bun run check` → cli + server only (misses renderer, `deploy/*`)
- `bun run typecheck` → cli + server + all `deploy/*` (renderer and shared are untyped JS/loose)
- All are hand-maintained `cd a && … && cd ../b && …` chains; adding a workspace means editing several chains and it's easy to silently miss one.

**Missing entirely:**

- CI. There is no `.github/workflows/` — nothing runs on PRs.
- A root `AGENTS.md`/`CLAUDE.md` telling agents how to build, test, and verify, and which invariants apply.
- Full-loop publish e2e: nothing spawns a real server and drives the real CLI through `login → publish → serve → share`. `cli/test/e2e.test.js` covers `dev` only; server tests use in-memory handlers.
- Browser-level rendering checks (explicitly scoped out of the existing e2e suite).

## Plan

### Phase 1 — One command that runs everything

`[x]` One name, one meaning — three scripts at root and in every workspace:

- `typecheck` → static checks only; `test` → test suites only; `ci` → the single gate (`typecheck` + `test` + builds). Root scripts only aggregate; each workspace owns its own three. No `check` script anywhere — the name is retired rather than redefined (in the wider ecosystem `check` reads as static-only: `cargo check`, `deno check`, `biome check`).
- Aggregation can't silently drop a workspace (enumerate workspaces, or a meta-test that the list matches `package.json`).
- Also fixes `cli`'s aliasing where `test` → `check` → typecheck + tests, so "run only cli tests" doesn't exist today.
- Acceptance: fresh clone + the pinned Bun version + `bun install --frozen-lockfile` + `bun run ci` passes, touches every suite, rebuilds every generated artifact, and leaves `git diff --exit-code` clean.

`[x]` Pin the Bun version: add a `packageManager` field (or `.bun-version`) — no pin exists today, and both this phase's acceptance and the Phase 2 workflow reference it. One pin, read by both.

`[x]` Make `shared/` a real workspace with its own `typecheck`/`test`/`ci` and a package name. It's currently imported by relative path (`../../shared/src/...`) and isn't in the gate at all. This belongs here, not in housekeeping: "every workspace owns its three scripts" must include shared, invariant 2 makes it the contract layer, and a package name makes Phase 5's import-boundary test trivial.

### Phase 2 — CI on every PR

`[ ]` Add `.github/workflows/ci.yml`: setup the repo-pinned Bun version, `bun install --frozen-lockfile`, `bun run ci`, on PRs and pushes to `main`. The workflow stays honest by construction — it runs exactly the one gate. Give it minimal GitHub-token permissions, a job timeout, and concurrency cancellation for superseded commits; make the resulting check required in branch protection.

`[ ]` Generated-artifact freshness is part of `ci`, not an occasional cleanup: rebuild `shared/src/site/default-renderer.generated.js` and every embedded CLI asset, then fail if the worktree is dirty. Add a Node/V8 adversarial regex timing check — this is new work, not an existing check (today the rule exists only as the design comment at `renderer/src/render.js:73`): Bun/JSC passing does not rule out catastrophic V8 backtracking in renderer code consumed elsewhere, and this is the only ci item guarding renderer code beyond its unit tests.

### Phase 3 — Full-loop publish e2e

`[ ]` A suite that spawns a **real server** and drives the **real CLI** end to end, in the auditable style of `cli/test/e2e.test.js` (inline fixtures, one behavior per test). Scratchwork components are real; the external identity provider is a controlled standards-shaped test server as described below.

- Loop: `login` → `publish` → fetch served site → republish (`.scratchwork.json` reuse) → `share`/`revoke` → access enforcement.
- Auth-negative lanes: callback state/capability mismatch, code interception and replay, denial at the provider, expired handoff-token replay, using a project-access token against a different project, allow-list removal revoking a live session mid-flow, and cookie/origin isolation across app/content hosts.
- Backends: `deploy/local-dev`, the Cloudflare Worker under miniflare, and the AWS handler against LocalStack using the real `server/deploy-aws` S3/DynamoDB adapters. `deploy/generic-aws`'s `local` mode substitutes file storage + in-memory DB, so it does not count for adapter coverage.
- All three backend lanes belong to `bun run ci` and run on every PR. They use local emulators and should be deterministic. Split a slower lane out only after measured runtime or flake data demonstrates a real problem, and preserve a required pre-merge gate for it rather than quietly making coverage optional.
- Likely a new top-level `e2e/` workspace, since it spans cli + server.

`[ ]` Test OAuth/OIDC in three complementary layers:

- **Hermetic full-loop provider:** a local test authorization server reached over real HTTP. Provider endpoints/JWKS are injectable only through an explicit test configuration restricted to loopback. It validates Scratchwork's outbound authorization request (`client_id`, exact redirect URI, `state`, transaction-specific `nonce`, PKCE `S256` challenge), supports success/denial/error callbacks, issues one-use codes and signed ID tokens, rotates keys, and can deliberately emit malformed responses. This is the deterministic PR test; only Google itself is substituted. Its threat cases track [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/info/rfc9700/).
- **Adversarial conformance:** run the [OpenID Foundation relying-party conformance suite](https://openid.net/certification/about-conformance-suite/) against Scratchwork's provider abstraction, locally in Docker and in CI. It complements the purpose-built fake with an independently maintained malicious/edge-case provider. Spike the exact automatable RP plan first; conformance coverage is required before launch and becomes part of `bun run ci`, not a permanent manual lane.
- **Real-provider smoke:** use a separate Google Cloud testing project and dedicated test users, never production credentials, following [Google's development/testing-project guidance](https://support.google.com/cloud/answer/13464018). Exercise the complete consent/login flow manually before releases and when scopes/provider configuration change. Do not make automated Google UI login a PR dependency: third-party authentication challenges are external state, while the hermetic and conformance lanes provide the repeatable gate.

`[ ]` Bring the CLI handoff in line with [OAuth 2.0 for Native Apps (RFC 8252)](https://datatracker.ietf.org/doc/html/rfc8252) and RFC 9700: the loopback receives a short-lived one-time authorization code, never the final bearer token; the code is bound to the CLI instance and exact callback with a CLI-generated PKCE verifier (`S256`) and exchanged over a back-channel POST. The listener binds an ephemeral loopback IP port, accepts only the exact callback path/state, and closes after the first successful exchange. Add tests for a competing local process, wrong verifier/state/path/origin, replay, expiry, and callback-server mismatch.

### Phase 4 — Bring existing code into compliance with invariant 1

The invariant starts out violated by existing code, not just guarding new code: much of `shared/src` is hand-rolled utility with a direct Effect stdlib equivalent. Pre-launch churn is accepted here: the goal is to delegate effects, errors, validation, encoding, resource lifetime, concurrency, and test services to Effect wherever it has a maintained equivalent, reducing repository-owned semantics and maximizing the guarantees available to callers.

`[ ]` Migrate `shared/src` to Effect-native and update call sites in cli and server as each util is replaced:

- `util/json.ts` (`isRecord`, `parseJson`) → `Schema` decoding
- `encoding/{base64,hex,bytes}.ts` → `effect/Encoding`
- `util/strings.ts`, `util/errors.ts` → Effect stdlib / `Data.TaggedError` where they're error-shaped
- `site/*` contract and serving helpers → Effect types at the exported surface

`[ ]` Sweep cli and server for remaining hand-rolled equivalents once shared is clean. Before replacing a helper, preserve its intended behavior with characterization/adversarial tests; after migration, delete the old implementation rather than retaining parallel paths.

`[ ]` Extract the async Web Crypto helpers (`hmac` in `auth.ts`, and any similar inline `crypto.subtle` use) into a small dedicated boundary module so `auth.ts` itself stays subject to the Effect-boundary lint. The allowlist stays file-level; boundary files stay tiny.

`[ ]` Bring existing signed payloads into invariant 3 compliance: add a discriminating `kind` to session and OAuth-state payloads, add the CLI authorization-code payload, version the format change deliberately, and verify every kind only through the shared signed-value codec.

- Exempt: `shared/src/site/default-renderer.generated.js` (build artifact written by `renderer/build.js`, not source).

### Phase 5 — Invariants: codify + enforce

Six invariants (registry below). They live **directly in root `AGENTS.md`** — the one file Claude (via `CLAUDE.md` symlink), Codex, and OpenCode all read natively — rather than behind a pointer agents might skip. Once moved, AGENTS.md is the sole normative prose copy and this plan links to it rather than retaining a second editable copy; anything a script can check graduates into `bun run ci` (agents drift; CI doesn't).

`[ ]` Root `AGENTS.md` (with `CLAUDE.md` symlinked to it): workspace map, `bun run ci`, the six invariants stated in full, and the standing rule "verify every diff against the invariants before committing."

`[ ]` Mechanize invariants 1 and 2's checkable cores in `bun run ci`: the Effect-boundary lint test (no async/await/Promise outside an exact, reviewed initial allowlist) and the import-boundary test (cli ⇄ server only via shared). The remaining invariants' checks are described below and in their registry entries.

`[ ]` Component-scan conformance test in `bun run ci`: import both `collectComponentNames` implementations (`renderer/src/components.js` and `shared/src/site/components.ts`), run them over a shared table of adversarial markdown samples (nested backtick runs, tags in comments, fences), assert identical output. Guards the one sanctioned duplication (see invariant 2).

`[ ]` Adversarial token corpus test in `bun run ci`, split by property:

- Integrity: for each token kind (session, OAuth state, CLI authorization code, project-access handoff/cookie), a valid token rejects every single-byte bit-flip of encoded payload and signature.
- Typed meaning: correctly sign malformed payloads and reject missing/extra/wrong-type fields, wrong `kind`/`version`/provider/use/project/scope/audience/nonce, extreme and boundary timestamps, future issuance, and every cross-kind pairing.
- Parser hardening: reject truncation, empty/extra/swapped segments, duplicate delimiters, prefix/suffix garbage, non-canonical base64url, and oversized inputs.
- Lifecycle: reject expiry and disallowed replay; explicitly document which short-lived stateless tokens remain replayable within their lifetime.

`[ ]` Session-secret length floor: retain the existing config failure below 32 bytes and add the missing regression test in `bun run ci` (length is checkable; entropy is not).

`[ ]` Server-owned route-policy registry: define API routes once in production code (prefer `server/core/src/api-routes.ts`, or the server implementation layer when `HttpApi` lands), with handler, method/path, authentication mode, minimum project role, mutation/origin policy, and response-visibility policy attached to each entry. The router dispatches from this registry; the test matrix is generated from the same definitions rather than maintained as a second list. CI fails if an API route has no policy and exercises credential kind × role × endpoint × public/private status, denying every unspecified combination.

`[ ]` Cookie/origin browser-security suite: use real app/content/homepage hostnames in a headless browser to prove secure-cookie-name selection, host/path scoping, SameSite behavior, cross-origin mutation rejection, safe redirects, private subresource isolation, and that arbitrary published JavaScript cannot plant or override an app session. This is narrowly scoped browser security coverage; browser rendering fidelity remains a non-goal.

`[ ]` Reusable backend conformance suites for `PrimitiveDb` and `ObjectStorage`, run unchanged against in-memory/file, D1/R2, and DynamoDB/S3 implementations. Cover conditional create/update conflicts, version/ETag behavior, pagination/cursor boundaries, missing records, concurrent writers, binary round trips, key validation, and identical error mapping.

`[ ]` A `check-invariants` skill (`.claude/skills/check-invariants/SKILL.md`) for the agent-pass residue: diff against main → report obeys/violates with file:line evidence. Claude-only convenience; Codex and OpenCode rely on the AGENTS.md standing rule + CI.

`[ ]` Stretch: migrate the shared CLI API contract to `@effect/platform` `HttpApi` (see invariant 2) — the structural fix that makes contract drift impossible. Auth callbacks, published-content routes, health checks, and other server-only endpoints remain server-owned.

### Phase 6 — Housekeeping

`[ ]` Confirm `examples/` and `notes/` are exempt from the gate on purpose, and document the exemption in `AGENTS.md`.

## Invariants registry

Six invariants, each enforced at three layers, strongest first: **structural** (the architecture makes violation impossible) → **mechanized** (a test in `bun run ci` fails) → **agent-pass** (judgment calls, per the standing rule in AGENTS.md).

### 1. Effect-native everywhere

All cli, server, and shared functionality is written against Effect: Effect types for errors and async, the Effect runtime, and the Effect standard library (Schema, platform, Encoding, stdlib data structures) instead of hand-rolled equivalents. The deliberate objective is maximal delegation: if Effect already owns a capability with equal or better semantics, use it rather than retaining a repository implementation. Pre-launch migration churn is accepted in exchange for fewer locally maintained semantics, stronger types at boundaries, service substitution in tests, controlled resource lifetime/concurrency, and a smaller custom surface after launch. Promise/async appears only at documented edges whose APIs inherently return Promises (Web Crypto/provider SDK/platform entrypoints); the initial allowlist names every such file and why it is a boundary.

- Scope: `cli/src/**`, `server/**/src/**`, `shared/src/**`. (`renderer/` is the sole exception — deliberately plain browser JS.)
- Mechanized: a ci test that fails on `async function` / `await` / `new Promise` / `.then(` in scope outside the exact reviewed allowlist of boundary files. New boundary = add its rationale to the allowlist in the same PR, which makes the exception reviewable; the baseline may shrink but not grow silently. The allowlist is file-level, so boundary files must stay tiny: extract async helpers into a dedicated module rather than allowlisting a large file (Phase 4 does this for `auth.ts`'s Web Crypto helpers).
- Agent-pass: the parts a grep can't judge — Schema over hand-rolled validation, Effect stdlib over reimplemented utilities, services/layers over ambient dependencies, scoped resources over manual cleanup, error channels over thrown exceptions, and no parallel legacy implementation left behind after a migration.

### 2. CLI↔server contracts live in `shared`

Anything the CLI and server both use — types, schemas, helpers — is exposed from `shared/`, never duplicated. The CLI-consumed JSON API contract is defined once, as Effect Schemas in `shared/src/publish/api.ts` (already the case today; extend there, never inline). Auth callbacks, published-content routing, health checks, deployment hooks, and other server-only endpoints stay in server.

- Structural (Phase 5 stretch): migrate the shared CLI API contract to `@effect/platform` `HttpApi`, so the server implements it and the CLI derives its client from the same object — duplication becomes impossible rather than forbidden.
- Mechanized: boundary test in ci — `cli/**` never imports from `server/**` and vice versa; the only code importable by both is `shared/**`. Plus: every CLI-consumed JSON route's request/response schema is imported from shared, not defined locally. Maintain an explicit inventory of those routes so a newly added CLI call cannot escape the check.
- Agent-pass: near-duplicate logic between cli and server that should be hoisted into shared (imports can't catch a reimplementation).
- **Sanctioned exception:** `renderer/src/components.js` deliberately duplicates the component-scan logic in `shared/src/site/components.ts` — the renderer is plain browser JS and must not depend on shared, and the CLI dev diagnostics must predict what the renderer's loader will do. This is the *only* permitted duplication, and only because a ci conformance test (Phase 5) asserts the two implementations agree; don't "fix" it by hoisting, and don't cite it as precedent for new duplication.

### 3. Auth goes through the chokepoints

The auth code stays reviewable because its security-critical operations are singular. Every MAC/tag comparison goes through `timingSafeEqual` (`server/core/src/tokens.ts`); every HMAC token is minted by `signValue` and verified by `verifySignedValue` (`server/core/src/auth.ts`); every RS256 JWT is verified via `jwt-rs256.ts`. Every token payload, including session and OAuth state, carries a `version` and discriminating `kind` claim so cross-kind confusion fails Schema decoding. No new comparison, signing, verification, or credential-transport path is introduced outside the chokepoints.

- Scope: `server/core/src/{auth,tokens,cookies,jwt-rs256,google-jwt,cloudflare-jwt,access}.ts`, `cli/src/{auth,api}.ts`, `cli/src/commands/login.ts`, and anything new that touches credentials.
- Mechanized: the adversarial token corpus (Phase 5) and OAuth full-loop tests (Phase 3) — integrity, typed meaning, parser hardening, lifecycle, PKCE/callback binding, and secret-length checks.
- Agent-pass: no `===` on cryptographic secrets/tags, no inline `crypto.subtle` signing/verifying outside the chokepoint modules, and every token kind gets `version` + `kind` claims and corpus coverage in the same PR.
- **Accepted trade-off** (decided, don't "fix" without Pete): sessions are stateless HMAC — no single-token revocation (levers: allow-list removal, `SESSION_VERSION` bump). The old bearer-token-in-loopback-query flow is not accepted: replace it with the Phase 3 short-lived code + PKCE exchange before launch.

### 4. API routes declare security policy and deny by default

Every API route is registered once with its handler and explicit authentication mode, minimum project role, mutation/origin policy, and response-visibility policy. Dispatch and the authorization matrix derive from that production registry, so adding an unclassified route is impossible and the default for an unspecified credential/role combination is denial.

- Scope: the server API router/registry, route handlers, and shared CLI API contract.
- Structural: the router dispatches only registered route definitions; handlers receive the authenticated principal/authorized project capability produced by policy middleware rather than independently reconstructing it.
- Mechanized: enumerate the registry and exercise credential kind × role × endpoint × public/private status; fail on missing policy metadata and deny every unspecified cell.
- Agent-pass: sensitive response fields are gated by the declared visibility policy, and no handler bypasses the registry or performs a weaker inline substitute.

### 5. Browser origins and credentials stay isolated

The app, content, and homepage origins are separate security principals. HTTPS accepts only the intended secure-prefixed cookie names; cookies remain host/path scoped; published content cannot plant or override an app session; mutations reject untrusted origins; redirects remain on their intended origin/path; and production proxy/origin trust is explicit.

- Scope: `server/core/src/{app,auth,cookies,http,config}.ts`, deployment proxy configuration, and published-content headers.
- Structural: cookie readers require the resolved origin mode instead of accepting both secure and local names; production public origins/trusted proxies are explicit configuration.
- Mechanized: the cross-host headless-browser security suite plus handler-level adversarial origin/redirect tests.
- Agent-pass: any new cookie, redirect, forwarded header, CORS rule, or cross-origin flow receives an explicit threat-boundary review.

### 6. Storage adapters have identical observable semantics

Every `PrimitiveDb` and `ObjectStorage` implementation honors the same contract for conditional writes, versions/ETags, pagination, missing values, key validation, concurrency, binary data, and typed failures. A deploy target cannot weaken ownership or consistency guarantees through adapter drift.

- Scope: in-memory/file implementations and D1/R2, DynamoDB/S3 deploy adapters.
- Structural: all deploy implementations satisfy the same Effect service interfaces and use shared contract fixtures.
- Mechanized: run the reusable adapter conformance suite unchanged against every implementation, using miniflare and LocalStack where required.
- Agent-pass: provider-specific retries/eventual-consistency behavior is documented and mapped without changing the core contract.

## Non-goals (for this branch)

- Browser-level rendering-fidelity tests remain out of scope. The narrowly scoped headless-browser origin/cookie security suite in Phase 5 is required because those guarantees exist only in a real browser.
- Coverage metrics, lint/format tooling changes, restructuring deploy projects.
