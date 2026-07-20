# Working in this repository

Scratchwork is tool for publishing static HTML and Markdown artifacts publicly and privately: a CLI (`scratchwork dev` / `publish` / `share`), a single-file Markdown renderer, and a publishing server that runs locally, on AWS, or on Cloudflare. `README.md` covers usage; this file covers how to change the code safely.

## Workspace map

Package names are `@scratchwork/<dir>` for everything under `server/` and `deploy/`
(plus `@scratchwork/shared` and `@scratchwork/e2e`); the two odd ones out are
`scratchwork-renderer` and `scratchwork-cli`.

- `renderer/` — build-once pipeline producing the single-file universal renderer
  (`index.html`). **Deliberately plain browser JS — the one exception to invariant 1.**
- `shared/` — code shared between CLI and server: the publish API contract
  (`src/publish/api.ts`), site serving helpers, crypto digest boundary. The only code
  importable by both cli and server.
- `cli/` — the `scratchwork` CLI, built with Effect: dev server with hot reload,
  publishing, login.
- `server/` — deploy tooling scripts only; the server itself lives in its sub-workspaces:
  - `server/core/` — platform-neutral publishing server core: auth, routing, storage
    contracts.
  - `server/deploy-aws/` — AWS Lambda + S3/DynamoDB adapters.
  - `server/deploy-cloudflare/` — Cloudflare Worker + R2/D1 adapters.
  - `server/deploy-local/` — local Bun deploy target.
- `deploy/*` — one deployment project per domain (generic-aws, cloudflare-vanilla,
  cloudflare-access, local-dev), each deployable with one command.
- `e2e/` — full-loop publish e2e: real server (local-dev, miniflare, LocalStack) driven
  by the real CLI, hermetic OAuth provider standing in for Google.

`examples/` and `notes/` are deliberately outside the gate: examples are user-facing
sample content, notes are working documents. Nothing in them is imported by shipped code.

## Build and test

- **The one gate:** `bun run ci` at the root. It runs `typecheck` + `test` + builds in
  every workspace (the list is derived from root `package.json` `workspaces`, so a new
  workspace joins automatically and a missing script fails the run), then checks that
  every generated artifact is fresh (`git diff` stays clean).
- Every workspace owns exactly three scripts: `typecheck` (static only), `test` (suites
  only), `ci` (the gate). There is no `check` script anywhere; the name is retired.
- Bun is pinned in `.bun-version`. Acceptance for any harness change: fresh clone +
  pinned Bun + `bun install --frozen-lockfile` + `bun run ci` passes and leaves
  `git diff --exit-code` clean.
- CI (`.github/workflows/ci.yml`) runs exactly `bun run ci` on every PR and push to
  main. Anything the gate should cover belongs in `bun run ci`, not in extra workflow
  steps.
- `shared/src/site/default-renderer.generated.js` is a build artifact written by
  `renderer/build.js` — never edit it by hand; it is exempt from source-code invariants.

## Standing rule

**Verify every diff against the six invariants below before committing.** Each invariant
is enforced at up to three layers, strongest first: _structural_ (the architecture makes
violation impossible) → _mechanized_ (a test in `bun run ci` fails) → _agent-pass_ (the
judgment calls listed under each invariant — that's you). When you find a violation,
fix it or flag it; never commit around it silently.

## The six invariants

### 1. Effect-native everywhere

All cli, server, and shared functionality is written against Effect: Effect types for
errors and async, the Effect runtime, and the Effect standard library (Schema, platform,
Encoding, stdlib data structures) instead of hand-rolled equivalents. The deliberate
objective is maximal delegation: if Effect already owns a capability with equal or
better semantics, use it rather than retaining a repository implementation. Promise/async
appears only at documented edges whose APIs inherently return Promises (Web Crypto,
provider SDKs, platform entrypoints); the allowlist in the boundary lint names every
such file and why it is a boundary.

- Scope: `cli/src/**`, `server/**/src/**`, `shared/src/**`. (`renderer/` is the sole
  exception — deliberately plain browser JS.)
- Mechanized: the Effect-boundary lint in `bun run ci` fails on `async` / `await` /
  `new Promise` / `.then(` in scope outside the exact reviewed allowlist of boundary
  files. New boundary = add its rationale to the allowlist in the same PR; the baseline
  may shrink but not grow silently. The allowlist is file-level, so boundary files must
  stay tiny: extract async helpers into a dedicated module rather than allowlisting a
  large file.
- Agent-pass: Schema over hand-rolled validation, Effect stdlib over reimplemented
  utilities, services/layers over ambient dependencies, scoped resources over manual
  cleanup, error channels over thrown exceptions, and no parallel legacy implementation
  left behind after a migration.

### 2. CLI↔server contracts live in `shared`

Anything the CLI and server both use — types, schemas, helpers — is exposed from
`shared/`, never duplicated. The CLI-consumed JSON API contract is defined once, as
Effect Schemas in `shared/src/publish/api.ts` (extend there, never inline). Auth
callbacks, published-content routing, health checks, deployment hooks, and other
server-only endpoints stay in server.

- Structural: the JSON API is defined once as an `@effect/platform` `HttpApi` object
  (`ScratchworkApi` in `shared/src/publish/api.ts`). The CLI derives its client from it
  (`HttpApiClient` in `cli/src/api.ts`), and the server's route registry, request
  decoding, and response encoding derive from the same object
  (`server/core/src/api-routes.ts`) — an endpoint, method, path, or schema that drifts
  between the two sides cannot typecheck.
- Mechanized: the import-boundary test in `bun run ci` — `cli/**` never imports from
  `server/**` and vice versa; the only code importable by both is `shared/**`. The CLI
  API-surface check fails on any hand-built `/api/` or `/auth/` URL in `cli/src`
  outside the explicit browser-navigation allowlist.
- Agent-pass: near-duplicate logic between cli and server that should be hoisted into
  shared (imports can't catch a reimplementation).
- **Sanctioned exception:** `renderer/src/components.js` deliberately duplicates the
  component-scan logic in `shared/src/site/components.ts` — the renderer is plain
  browser JS and must not depend on shared, and the CLI dev diagnostics must predict
  what the renderer's loader will do. This is the _only_ permitted duplication, and only
  because a ci conformance test asserts the two implementations agree. Don't "fix" it by
  hoisting, and don't cite it as precedent for new duplication.

### 3. Auth goes through the chokepoints

The auth code stays reviewable because its security-critical operations are singular.
Every MAC/tag comparison goes through `timingSafeEqual` (`server/core/src/tokens.ts`);
every HMAC token is minted by `signValue` and verified by `verifySignedValue`
(`server/core/src/auth.ts`); every RS256 JWT is verified via `jwt-rs256.ts`. Every token
payload, including session and OAuth state, carries a `version` and discriminating
`kind` claim so cross-kind confusion fails Schema decoding. No new comparison, signing,
verification, or credential-transport path is introduced outside the chokepoints.

- Scope: `server/core/src/{auth,tokens,cookies,jwt-rs256,google-jwt,cloudflare-jwt,access}.ts`,
  `cli/src/{auth,api}.ts`, `cli/src/commands/login.ts`, and anything new that touches
  credentials.
- Mechanized: the adversarial token corpus and OAuth full-loop tests in `bun run ci` —
  integrity, typed meaning, parser hardening, lifecycle, PKCE/callback binding, and
  secret-length checks.
- Agent-pass: no `===` on cryptographic secrets/tags, no inline `crypto.subtle`
  signing/verifying outside the chokepoint modules, and every new token kind gets
  `version` + `kind` claims and corpus coverage in the same PR.
- **Accepted trade-off** (decided; don't "fix" without Pete): sessions are stateless
  HMAC — no single-token revocation (levers: allow-list removal, `SESSION_VERSION`
  bump).

### 4. API routes declare security policy and deny by default

Every API route is registered once with its handler and explicit authentication mode,
minimum project role, mutation/origin policy, and response-visibility policy. Dispatch
and the authorization matrix derive from that production registry, so adding an
unclassified route is impossible and the default for an unspecified credential/role
combination is denial.

- Scope: the server API router/registry, route handlers, and shared CLI API contract.
- Structural: the router dispatches only registered route definitions, and the registry
  is a mapped type keyed by the shared contract's endpoint names — a contract endpoint
  without a policy, or a policy for a nonexistent endpoint, is a compile error; handlers
  receive the authenticated principal/authorized project capability produced by policy
  middleware rather than independently reconstructing it.
- Mechanized: enumerate the registry and exercise credential kind × role × endpoint ×
  public/private status; fail on missing policy metadata and deny every unspecified cell.
- Agent-pass: sensitive response fields are gated by the declared visibility policy,
  and no handler bypasses the registry or performs a weaker inline substitute.

### 5. Browser origins and credentials stay isolated

The app, content, and homepage origins are separate security principals. HTTPS accepts
only the intended secure-prefixed cookie names; cookies remain host/path scoped;
published content cannot plant or override an app session; mutations reject untrusted
origins; redirects remain on their intended origin/path; and production proxy/origin
trust is explicit.

- Scope: `server/core/src/{app,auth,cookies,http,config}.ts`, deployment proxy
  configuration, and published-content headers.
- Structural: cookie readers require the resolved origin mode instead of accepting both
  secure and local names; production public origins/trusted proxies are explicit
  configuration.
- Mechanized: the cross-host headless-browser security suite plus handler-level
  adversarial origin/redirect tests.
- Agent-pass: any new cookie, redirect, forwarded header, CORS rule, or cross-origin
  flow receives an explicit threat-boundary review.

### 6. Storage adapters have identical observable semantics

Every `PrimitiveDb` and `ObjectStorage` implementation honors the same contract for
conditional writes, versions/ETags, pagination, missing values, key validation,
concurrency, binary data, and typed failures. A deploy target cannot weaken ownership
or consistency guarantees through adapter drift.

- Scope: in-memory/file implementations and D1/R2, DynamoDB/S3 deploy adapters.
- Structural: all deploy implementations satisfy the same Effect service interfaces and
  use shared contract fixtures.
- Mechanized: the reusable adapter conformance suite runs unchanged against every
  implementation, using miniflare and LocalStack where required.
- Agent-pass: provider-specific retries/eventual-consistency behavior is documented and
  mapped without changing the core contract.
