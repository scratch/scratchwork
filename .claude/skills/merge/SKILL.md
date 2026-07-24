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

```bash
gh auth status
gh pr view <n> --json title,isDraft,state,baseRefName,headRefName,isCrossRepository
```

The PR must be open and not a draft. **`isCrossRepository` must be false** — a fork's
branch can't be fetched from `origin` or force-pushed back, so step 2 would die
mid-procedure; reject it here instead. **`baseRefName` must be `main`** — this skill
rebases onto `main` and assumes the merge lands there. On a stacked PR based on
another branch, stop: rebasing it onto `main` would rewrite it to include or drop the
base branch's commits, and the review target, the rebase, and the merge destination
would all disagree.

Show the user the title, the diff stat, and what you're about to do, then get
approval for the **whole run** — after that, rebase, review, fix, and merge without
asking again. Re-confirm only if something changes the deal: a conflict resolution
you aren't confident in, or the diff touching release/deploy machinery you didn't
flag up front.

### 2. Get a checkout, then rebase

**Never write shell variables you intend to use later.** Each Bash call is a fresh
shell — `$WT` and `$REVIEWED` set in one block are empty in the next. Print the value,
then substitute the literal into later commands.

Find where the branch lives. Do **not** create a worktree: `git worktree add` fails
when the branch is checked out anywhere, `--show-toplevel` returns the wrong root when
you are already inside a linked worktree, and removing a worktree you are standing in
breaks every command after it.

```bash
git fetch origin main <branch>
git worktree list                       # is <branch> already checked out?
```

- **Already checked out** (any worktree, including the primary one): use that
  directory.
- **Not checked out:** check it out in the primary checkout — the first line of
  `git worktree list` — and note that you must restore it to `main` in step 5.

Either way the directory must be clean (`git status --porcelain` empty). If it's
dirty, stop and hand it back; never stash the user's work.

Now reconcile with the remote **before** rebasing:

```bash
git rev-list --count <branch>..origin/<branch>    # non-zero → local is stale
```

This check is not optional. Step 2 just fetched `origin/<branch>`, which means
`--force-with-lease` will compare against the ref it *just updated* and pass happily
— so a stale local branch would force-push away commits that exist only on the
remote, and nothing downstream would notice. If the count is non-zero,
`git reset --hard origin/<branch>` before continuing.

```bash
git rebase origin/main
git push --force-with-lease
bun install --frozen-lockfile          # node_modules may be absent or stale
```

Resolve only conflicts whose resolution is mechanical and whose intent on both sides
is unambiguous. Anything where you'd be choosing behavior rather than reconciling
text: `git rebase --abort` and hand it back to the user.

This is the one failure the rest of the pipeline cannot catch — fable will review
whatever tree you produce and find a misresolution perfectly coherent.

### 3. Adversarial review with fable

Spawn **two** subagents with the Agent tool, in parallel, both with `model: "fable"`
(the alias — the model parameter takes `sonnet|opus|haiku|fable`, not a full model
ID). **One lens each**, not both lenses to both agents.

Give each one **the checkout directory from step 2** — a subagent starts in the
session's cwd, not your working directory, so a reviewer that isn't told where to
look will diff the wrong tree and cheerfully report nothing. Also give it the PR
number and title, and `git diff origin/main...HEAD` as the target.

You are the author of the fixes; they are the reviewers. Keep that split — a model
reviewing its own fixes is not an adversarial review.

Instruct each to hunt for reasons this should **not** land — a reviewer that returns
"looks good to me" has not done its job — and to report findings as
`{file, line, severity: blocking|nit, claim, failure_scenario}`, empty only if it
genuinely finds nothing after a real search.

- **Lens 1 — defects.** Correctness, security, regressions, error handling,
  concurrency, data loss. Where does this break in production? What input makes it
  wrong?
- **Lens 2 — invariant conformance.** Run the `check-invariants` skill's procedure
  against the diff. That skill owns *what to check* — follow its per-invariant
  agent-pass bullets rather than a restatement here, so this file can't drift from it.
  Two deliberate overrides, which you must state in the reviewer's prompt: diff against
  `origin/main...HEAD`, not that skill's `main...HEAD` (local `main` may be stale, and
  both lenses must review the same tree); and return the findings JSON above, not that
  skill's per-invariant pass/fail report, so triage can consume both lenses the same way.

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

### 5. Merge the tree you reviewed

Print the reviewed commit and confirm `main` hasn't moved out from under it:

```bash
git rev-parse HEAD                        # copy this SHA; do not store it in a variable
git fetch origin main
git rev-list --count HEAD..origin/main    # non-zero → main moved; restart at step 2
```

Wait for the real check on that head — a local `bun run ci` is a prediction, the
workflow run is the fact. `gh pr checks` errors rather than waits if GitHub hasn't
registered the run yet, so retry a few times before believing it.

```bash
gh pr checks <n> --watch
gh pr merge <n> --merge --match-head-commit <the SHA you printed above>
```

`--match-head-commit` is what makes this honest: if anything landed on the branch
after the review, the merge is refused instead of silently shipping an unreviewed
tree. Merge commits match this repo's history.

Then clean up the remote only:

```bash
git push origin --delete <branch>
```

**Leave local state alone.** Deleting the local branch fails while it is checked out,
and the checkout may be one the user lives in — so `--delete-branch` is not used above.
If you checked the branch out in the primary checkout in step 2, restore it
(`git checkout main && git pull`). Then tell the user which local branch and which
directory are still there, so they can clean up if they want to.

## Report

The PR number and title, rebase result, review rounds, findings fixed and findings
discarded (with why), and the final `main` SHA. If you stopped short of merging, say
exactly why and what the user needs to decide.
