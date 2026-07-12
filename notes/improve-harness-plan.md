# Keeping the codebase healthy: harness + invariants

**Goal:** a multi-pronged approach to keeping this codebase healthy as it changes:

1. one command that exercises everything that matters, run automatically on every PR;
2. a registry of invariants — things that must remain true about the codebase — that agents (Claude, Codex) verify against every change, and that graduate into mechanical checks over time.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

## Where we are today

**Test suites that exist:**

| Area | Suite | What it covers |
|---|---|---|
| renderer | `renderer/test/{parser,render}.test.js` | Markdown parser + render output (bun/JSC, no browser) |
| cli | `cli/test/{api,auth,help,components}.test.js` | Unit-ish tests against real loopback HTTP servers |
| cli | `cli/test/e2e.test.js` (~1,500 lines) | Real e2e for `scratchwork dev`: spawns the CLI, drives it over HTTP |
| server | `server/core/test/*` | Core app via in-memory handler + test layers (`helpers.ts`) |
| server | `server/deploy-aws/test/handler.test.ts`, `server/deploy-cloudflare/test/{r2-storage,worker}.test.ts` | Deploy-target adapters |
| server | `server/scripts/{env,server-settings}.test.ts` | Deploy tooling |

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

`[ ]` Make root `bun run check` the single gate: typecheck + every test suite in every workspace, including renderer and `deploy/*`.

- Each workspace owns a `check` script; the root script only aggregates, in a way that can't silently drop a workspace (enumerate workspaces, or a meta-test that the list matches `package.json`).
- Acceptance: fresh clone + `bun install` + `bun run check` passes and touches every suite.

### Phase 2 — CI on every PR

`[ ]` Add `.github/workflows/ci.yml`: setup bun, `bun install`, `bun run check`, plus renderer/CLI builds, on PRs and pushes to `main`.

### Phase 3 — Full-loop publish e2e

`[ ]` A suite that spawns a **real server** and drives the **real CLI** end to end, in the auditable style of `cli/test/e2e.test.js` (inline fixtures, one behavior per test, nothing mocked).

- Loop: `login` → `publish` → fetch served site → republish (`.scratchwork.json` reuse) → `share`/`revoke` → access enforcement.
- Backends: `deploy/local-dev` (default suite); the Cloudflare Worker under miniflare (opt-in/CI-only lane).
- Likely a new top-level `e2e/` workspace, since it spans cli + server.

### Phase 4 — Invariants: registry + verification pass

The registry below is the single source of truth. Everything else is a thin adapter pointing at it — invariants are never copied into AGENTS.md or a skill, and any invariant a script can check graduates into `bun run check` (agents drift; CI doesn't).

`[ ]` Pete: seed the registry (drafts below are starting points to confirm/edit).

`[ ]` Root `AGENTS.md` (with `CLAUDE.md` symlinked to it): workspace map, `bun run check`, pointer to the registry, and the standing rule "verify every change against the registry before committing." Codex reads AGENTS.md natively; Claude gets the same file via the symlink.

`[ ]` A `check-invariants` skill (`.claude/skills/check-invariants/SKILL.md`): diff against main → select registry entries whose scope touches the changed files → report obeys/violates with file:line evidence. The skill reads the registry fresh; it contains no invariants itself.

`[ ]` Mechanize what's mechanizable: ReDoS timing check under node (bun/JSC can't catch V8 backtracking), embedded-renderer freshness (CLI bundle matches a rebuild of `renderer/src`), config-explicitness test over `server/core/src/config.ts`.

### Phase 5 — Housekeeping

`[ ]` `shared/` is imported by relative path but isn't a workspace — make it one or document why not. Confirm `examples/` and `notes/` are exempt from the gate on purpose.

## Invariants registry

Format: **statement** — scope · how to verify · enforcement (`manual` → `agent-pass` → `mechanized`).

### Boundaries & layout

- *(e.g. server/core must not import from deploy targets; cli must not import server internals — add here)*

### Server

- **Server code is Effect-native; Promise boundaries are deliberate and documented** (draft) — `server/**/src/**` · no bare async/Promise outside the existing documented boundaries (`google-jwt.ts`, deploy tooling); exports have docstrings · agent-pass
- **Consequential config has no silent defaults** (draft) — config surfaces · security/data-location settings are required, fail fast when unset · agent-pass → mechanize (Phase 4)

### Renderer

- **Regex alternatives stay disjoint; no V8-exponential backtracking** (draft) — `renderer/src/**` · new regexes checked for overlapping alternatives; adversarial inputs timed under node · agent-pass → mechanize (Phase 4)

### Testing

- *(e.g. e2e tests follow the auditable inline-fixture style; new routes get handler tests — add here)*

### CLI

- *(add here)*

## Non-goals (for this branch)

- Browser-level rendering tests (headless browser). Heavy dependency for modest marginal coverage; revisit after Phases 1–4.
- Coverage metrics, lint/format tooling changes, restructuring deploy projects.
