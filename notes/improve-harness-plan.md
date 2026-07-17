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

`[x]` Add `.github/workflows/ci.yml`: setup the repo-pinned Bun version, `bun install --frozen-lockfile`, `bun run ci`, on PRs and pushes to `main`. The workflow stays honest by construction — it runs exactly the one gate. Give it minimal GitHub-token permissions, a job timeout, and concurrency cancellation for superseded commits; make the resulting check required in branch protection.

`[x]` Generated-artifact freshness is part of `ci`, not an occasional cleanup: rebuild `shared/src/site/default-renderer.generated.js` and every embedded CLI asset, then fail if the worktree is dirty. Add a Node/V8 adversarial regex timing check — this is new work, not an existing check (today the rule exists only as the design comment at `renderer/src/render.js:73`): Bun/JSC passing does not rule out catastrophic V8 backtracking in renderer code consumed elsewhere, and this is the only ci item guarding renderer code beyond its unit tests.

### Phase 3 — Full-loop publish e2e

`[x]` A suite that spawns a **real server** and drives the **real CLI** end to end, in the auditable style of `cli/test/e2e.test.js` (inline fixtures, one behavior per test). Scratchwork components are real; the external identity provider is a controlled standards-shaped test server as described below. *(Landed as the `e2e/` workspace: `e2e/src/suite.ts` runs the full loop per backend, `e2e/test/auth-negative.test.ts` covers the negative lanes; expired-token and single-byte-tamper cases are covered at the unit level in `server/core/test/{auth,app}.test.ts`.)*

- Loop: `login` → `publish` → fetch served site → republish (`.scratchwork.json` reuse) → `share`/`revoke` → access enforcement.
- Auth-negative lanes: callback state/capability mismatch, code interception and replay, denial at the provider, expired handoff-token replay, using a project-access token against a different project, allow-list removal revoking a live session mid-flow, and cookie/origin isolation across app/content hosts.
- Backends: `deploy/local-dev`, the Cloudflare Worker under miniflare, and the AWS handler against LocalStack using the real `server/deploy-aws` S3/DynamoDB adapters. `deploy/generic-aws`'s `local` mode substitutes file storage + in-memory DB, so it does not count for adapter coverage.
- All three backend lanes belong to `bun run ci` and run on every PR. They use local emulators and should be deterministic. Split a slower lane out only after measured runtime or flake data demonstrates a real problem, and preserve a required pre-merge gate for it rather than quietly making coverage optional.
- Likely a new top-level `e2e/` workspace, since it spans cli + server.

`[~]` Test OAuth/OIDC in three complementary layers *(hermetic provider done — `e2e/src/oauth-provider.ts` + the loopback-gated `SCRATCHWORK_LOCAL_OAUTH_*` config; conformance suite spiked in `notes/oidc-conformance-spike.md`, implementation pending; real-provider smoke is a manual pre-release step by design)*:

- **Hermetic full-loop provider:** a local test authorization server reached over real HTTP. Provider endpoints/JWKS are injectable only through an explicit test configuration restricted to loopback. It validates Scratchwork's outbound authorization request (`client_id`, exact redirect URI, `state`, transaction-specific `nonce`, PKCE `S256` challenge), supports success/denial/error callbacks, issues one-use codes and signed ID tokens, rotates keys, and can deliberately emit malformed responses. This is the deterministic PR test; only Google itself is substituted. Its threat cases track [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/info/rfc9700/).
- **Adversarial conformance:** run the [OpenID Foundation relying-party conformance suite](https://openid.net/certification/about-conformance-suite/) against Scratchwork's provider abstraction, locally in Docker and in CI. It complements the purpose-built fake with an independently maintained malicious/edge-case provider. Spike the exact automatable RP plan first; conformance coverage is required before launch and becomes part of `bun run ci`, not a permanent manual lane.
- **Real-provider smoke:** use a separate Google Cloud testing project and dedicated test users, never production credentials, following [Google's development/testing-project guidance](https://support.google.com/cloud/answer/13464018). Exercise the complete consent/login flow manually before releases and when scopes/provider configuration change. Do not make automated Google UI login a PR dependency: third-party authentication challenges are external state, while the hermetic and conformance lanes provide the repeatable gate.

`[x]` Bring the CLI handoff in line with [OAuth 2.0 for Native Apps (RFC 8252)](https://datatracker.ietf.org/doc/html/rfc8252) and RFC 9700: the loopback receives a short-lived one-time authorization code, never the final bearer token; the code is bound to the CLI instance and exact callback with a CLI-generated PKCE verifier (`S256`) and exchanged over a back-channel POST. The listener binds an ephemeral loopback IP port, accepts only the exact callback path/state, and closes after the first successful exchange. Add tests for a competing local process, wrong verifier/state/path/origin, replay, expiry, and callback-server mismatch.

### Phase 4 — Bring existing code into compliance with invariant 1

The invariant starts out violated by existing code, not just guarding new code: much of `shared/src` is hand-rolled utility with a direct Effect stdlib equivalent. Pre-launch churn is accepted here: the goal is to delegate effects, errors, validation, encoding, resource lifetime, concurrency, and test services to Effect wherever it has a maintained equivalent, reducing repository-owned semantics and maximizing the guarantees available to callers.

`[x]` Migrate `shared/src` to Effect-native and update call sites in cli and server as each util is replaced:

- `util/json.ts` (`isRecord`, `parseJson`) → `Schema` decoding *(deleted; call sites use `Schema.parseJson(...)` decoding and `Predicate.isRecord`)*
- `encoding/{base64,hex,bytes}.ts` → `effect/Encoding` *(hand-rolled codecs deleted; `base64.ts` retains only `decodedBase64ByteLength` — size-without-decode has no Effect equivalent — with a conformance test pinning agreement with `Encoding.decodeBase64`; `bytes.ts`'s `toArrayBuffer` retained with documented rationale, Encoding covers codecs not BufferSource conversion)*
- `util/strings.ts`, `util/errors.ts` → Effect stdlib / `Data.TaggedError` where they're error-shaped *(`strings.ts` deleted — `nonEmpty` collapsed into plain `||` fallbacks; `errors.ts` retained with documented rationale: no Effect stdlib equivalent for unknown-thrown-value → message)*
- `site/*` contract and serving helpers → Effect types at the exported surface *(routing/serve/html/renderer/files were already Effect; `publish/bundle.ts` is now the single Schema definition of the bundle wire format — `decodePublishBundle` deleted, path uniqueness enforced in the schema; remaining `site/*` helpers are pure total functions, which is the Effect-idiomatic shape for them)*

`[x]` Sweep cli and server for remaining hand-rolled equivalents once shared is clean. Before replacing a helper, preserve its intended behavior with characterization/adversarial tests; after migration, delete the old implementation rather than retaining parallel paths. *(auth.json validation → Schema in `cli/src/auth.ts`; JWKS env parsing → Schema in `server/core/src/config.ts`; API error-body sniffing → Schema in `cli/src/api.ts`; `db.ts` JSON codecs already Effect-native with domain validation and stay.)*

`[x]` Extract the async Web Crypto helpers (`hmac` in `auth.ts`, and any similar inline `crypto.subtle` use) into a small dedicated boundary module so `auth.ts` itself stays subject to the Effect-boundary lint. The allowlist stays file-level; boundary files stay tiny. *(Boundary set is now six small documented files: `server/core/src/auth-crypto.ts` (HMAC + AES-GCM), `shared/src/crypto/digest.ts` (SHA-256 for PKCE/content hashing, shared by cli and server), `cli/src/commands/login-callback-server.ts` (Bun.serve loopback), plus the pre-existing `jwt-rs256.ts`/`google-jwt.ts`/`cloudflare-jwt.ts` provider boundary — the Google token-endpoint POST moved from `auth.ts` into `google-jwt.ts`. `auth.ts` and `login.ts` contain no async/await/Promise.)*

`[x]` Bring existing signed payloads into invariant 3 compliance: add a discriminating `kind` to session and OAuth-state payloads, add the CLI authorization-code payload, version the format change deliberately, and verify every kind only through the shared signed-value codec. *(Landed with Phase 3: all four payload schemas carry `version` + `kind` literals and every kind signs/verifies only through `signValue`/`verifySignedValue`; the exhaustive adversarial corpus remains Phase 5.)*

- Exempt: `shared/src/site/default-renderer.generated.js` (build artifact written by `renderer/build.js`, not source).

### Phase 5 — Invariants: codify + enforce

Six invariants (registry below). They live **directly in root `AGENTS.md`** — the one file Claude (via `CLAUDE.md` symlink), Codex, and OpenCode all read natively — rather than behind a pointer agents might skip. Once moved, AGENTS.md is the sole normative prose copy and this plan links to it rather than retaining a second editable copy; anything a script can check graduates into `bun run ci` (agents drift; CI doesn't).

`[x]` Root `AGENTS.md` (with `CLAUDE.md` symlinked to it): workspace map, `bun run ci`, the six invariants stated in full, and the standing rule "verify every diff against the invariants before committing."

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

`[x]` Confirm `examples/` and `notes/` are exempt from the gate on purpose, and document the exemption in `AGENTS.md`.

## Invariants registry

The six invariants now live in full in the root [`AGENTS.md`](../AGENTS.md) (with
`CLAUDE.md` symlinked to it) — the sole normative copy. Each is enforced at up to three
layers, strongest first: **structural** (the architecture makes violation impossible) →
**mechanized** (a test in `bun run ci` fails) → **agent-pass** (judgment calls, per the
standing rule in AGENTS.md). In brief:

1. **Effect-native everywhere** — cli/server/shared code is written against Effect; async/Promise only in the reviewed boundary-file allowlist.
2. **CLI↔server contracts live in `shared`** — never duplicated; the renderer component-scan is the one sanctioned, conformance-tested exception.
3. **Auth goes through the chokepoints** — `timingSafeEqual`, `signValue`/`verifySignedValue`, `jwt-rs256.ts`; every payload carries `version` + `kind`.
4. **API routes declare security policy and deny by default** — one registry with auth mode, role, origin, and visibility policy per route.
5. **Browser origins and credentials stay isolated** — app/content/homepage are separate principals; cookies, redirects, and origin trust are explicit.
6. **Storage adapters have identical observable semantics** — one conformance suite across in-memory/file, D1/R2, DynamoDB/S3.

## Non-goals (for this branch)

- Browser-level rendering-fidelity tests remain out of scope. The narrowly scoped headless-browser origin/cookie security suite in Phase 5 is required because those guarantees exist only in a real browser.
- Coverage metrics, lint/format tooling changes, restructuring deploy projects.
