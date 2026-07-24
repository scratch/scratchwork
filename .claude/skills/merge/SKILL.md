---
name: merge
description: Land a PR — rebase onto latest main, review it adversarially with fable, fix every finding, then merge. Use when asked to merge a PR, land a branch, or ship a change.
---

# Merge

Land one PR on `main`: rebase, review, fix, merge. Takes a PR number
(`/merge 28`); with no argument, use the PR for the current branch
(`gh pr view --json number`).

## Ground rules

- **Rebase, never merge-from-main.** The premise is that reviewed code is the code
  that lands. A merge commit from `main` means fable reviewed a tree that never
  existed.
- **`bun run ci` green is necessary and never sufficient.** Fable's verdict is the
  other half of the gate.
- **Never weaken the gate to get a merge.** No skipped tests, loosened assertions,
  new ignore rules, or edits to `.github/workflows/ci.yml`. If landing the PR
  requires any of that, stop and say so.

## Procedure

### 1. Preflight and confirm

Check `gh auth status`, and that the PR is open and not a draft. Show the user the
PR title, the diff stat, and what you're about to do, then get approval for the
**whole run** — after that, rebase, review, fix, and merge without asking again.

Re-confirm only if something changes the deal: a conflict resolution you aren't
confident in, or the diff touching release/deploy machinery you didn't flag up front.

### 2. Rebase onto latest `main`

Work in a worktree, not the main checkout. Reuse the branch's existing worktree if
`git worktree list` shows one; otherwise
`git worktree add /Users/koomen/git/scratch/scratchwork-worktrees/<branch> <branch>`.

```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

Resolve only conflicts whose resolution is mechanical and whose intent on both sides
is unambiguous. Anything where you'd be choosing behavior rather than reconciling
text: `git rebase --abort` and hand it back to the user.

This is the one failure the rest of the pipeline cannot catch — fable will review
whatever tree you produce and find a misresolution perfectly coherent.

### 3. Adversarial review with fable

Spawn **two** subagents with the Task tool, in parallel, both on `claude-fable-5`.
Give each the PR number and title, and `git diff origin/main...HEAD` as the target.

You are the author of the fixes; they are the reviewers. Keep that split — a model
reviewing its own fixes is not an adversarial review.

Instruct each to hunt for reasons this should **not** land — a reviewer that returns
"looks good to me" has not done its job — and to report findings as
`{file, line, severity: blocking|nit, claim, failure_scenario}`, empty only if it
genuinely finds nothing after a real search.

- **Lens 1 — defects.** Correctness, security, regressions, error handling,
  concurrency, data loss. Where does this break in production? What input makes it
  wrong?
- **Lens 2 — invariant conformance.** Read `AGENTS.md` in full, then check the diff
  against the *agent-pass* bullets of all six invariants (same job as the
  `check-invariants` skill). CI already mechanizes the greppable cores; the
  reviewer's value is the judgment residue.

### 4. Triage, then fix

Adversarial reviewers over-report — that's the cost of telling them to attack.
Confirm each finding against the actual code before acting: trace the failure
scenario through the real control flow, and check the premise still holds after the
rebase. Discard what doesn't survive and say what you discarded and why. Don't fix a
phantom to make a reviewer happy.

Fix every surviving finding, `blocking` and `nit` alike. Then `bun run ci` (needs
Docker for the LocalStack e2e lane), commit, push, and re-run step 3 on the new diff.

**At most 3 rounds.** If findings still survive, stop and report — a PR that can't
converge in three rounds has a problem this skill is the wrong tool for.

### 5. Merge

Wait for the real check on the pushed head — a local `bun run ci` is a prediction,
the workflow run is the fact. `ci` is a required check on `main`, so a red run can't
merge anyway.

```bash
gh pr checks <n> --watch
gh pr merge <n> --merge --delete-branch
git worktree remove <path>
```

Merge commits match this repo's history.

## Report

The PR number and title, rebase result, review rounds, findings fixed and findings
discarded (with why), and the final `main` SHA. If you stopped short of merging, say
exactly why and what the user needs to decide.
