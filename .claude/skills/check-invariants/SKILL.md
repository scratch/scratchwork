---
name: check-invariants
description: Verify the current branch's diff against the six invariants in AGENTS.md — the agent-pass judgment calls CI cannot check. Use before committing or when asked to review a diff for invariant compliance.
---

# Check invariants

Verify the working diff against the six invariants in the root `AGENTS.md` (the sole
normative copy — read it first). CI already mechanizes the checkable cores
(`scripts/check-boundaries.ts`, the conformance suites, the token corpus, the API
policy matrix); **your job is the residue: the judgment calls a grep cannot make.**

## Procedure

1. Read `AGENTS.md` in full.
2. Collect the diff: `git diff main...HEAD` plus `git diff` and `git diff --cached`
   for uncommitted work. If the diff is empty, say so and stop.
3. For each changed file, decide which invariants apply (scope lists live under each
   invariant in AGENTS.md) and check the diff against the **agent-pass bullets**:
   - **Invariant 1 (Effect-native):** Schema over hand-rolled validation; Effect stdlib
     over reimplemented utilities; services/layers over ambient dependencies; scoped
     resources over manual cleanup; error channels over thrown exceptions; no parallel
     legacy implementation left behind. A new allowlisted boundary file must be tiny and
     its rationale must hold.
   - **Invariant 2 (contracts in shared):** near-duplicate logic between cli and server
     that should be hoisted; new CLI-consumed wire shapes defined outside
     `shared/src/publish/api.ts`; any new duplication citing the sanctioned
     component-scan exception as precedent (there is exactly one exception).
   - **Invariant 3 (auth chokepoints):** any `===` on secrets/tags; inline
     `crypto.subtle` signing/verifying outside the chokepoint modules; a new token kind
     without `version` + `kind` claims and corpus coverage in the same PR; any new
     credential-transport path outside the chokepoints.
   - **Invariant 4 (route policy):** a handler bypassing the registry or independently
     reconstructing the principal/capability; sensitive response fields not gated by the
     declared visibility policy; a policy declaration that got weaker without
     justification.
   - **Invariant 5 (origin isolation):** any new cookie, redirect, forwarded header,
     CORS rule, or cross-origin flow — each needs an explicit threat-boundary review in
     the PR; flag any that lack one.
   - **Invariant 6 (adapter semantics):** adapter changes without a matching
     conformance-suite update; provider-specific behavior papered over instead of
     documented and mapped.
4. Run the mechanized gate too (cheap, catches drift while you review):
   `bun scripts/check-boundaries.ts`.

## Report format

One line per invariant: `obeys` / `violates` / `not touched`, with `file:line`
evidence for every `violates` and for any `obeys` that needed judgment. End with a
verdict: **pass** (commit away) or **fail** (list what must change first). Do not
soften violations into suggestions — the standing rule in AGENTS.md is fix or flag,
never commit around silently.
