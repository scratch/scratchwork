---
name: merge
description: Land a PR — rebase onto latest main, review it adversarially with fable, fix every finding, then merge. Use when asked to merge a PR, land a branch, or ship a change.
---

# Merge

Land one PR on `main`: rebase, review, fix, merge. Takes a PR number (`/merge 28`);
with no argument, use the current branch's PR (`gh pr view --json number`). The PR
must be open, not a draft, and based on `main` — otherwise stop and say why.

Invoking the skill is approval for the whole run — don't re-confirm along the way.
Check back only if a conflict resolution would mean choosing behavior, or the diff
touches release/deploy machinery you didn't flag up front.

**Never weaken the gate to get a merge.** No skipped tests, loosened assertions, new
ignore rules, or edits to `.github/workflows/ci.yml`. If landing requires any of
that, stop and say so.

Two Bash-harness rules. Never set a shell variable for later use — each call is a
fresh shell; print the value, then substitute the literal into later commands. And
start every Bash call after step 1 by `cd`-ing into the scratch worktree by literal
path — cwd doesn't reliably persist either, and a command that lands in the user's
checkout instead would build, commit, or push the wrong tree.

## 1. Rebase in a scratch worktree

Work on `origin/<branch>` in a detached throwaway worktree — never in a checkout the
user lives in, and never on a possibly-stale local branch. Two preflights:

- If a local `<branch>` exists (`git branch --list <branch>`), it must not be
  **ahead** of origin — `git rev-list --count origin/<branch>..<branch>` must be 0
  after the fetch below. If it isn't, stop: the PR is missing unpushed work, and
  only the user can decide to push it.
- If `<scratchpad>/merge-<n>` is left over from an earlier run, clear it with
  `git worktree remove --force` before adding it again.

```bash
git fetch origin main <branch>
git rev-parse origin/<branch>        # print this SHA — the push lease below pins it
git worktree add <scratchpad>/merge-<n> origin/<branch> --detach
cd <scratchpad>/merge-<n> && git rebase origin/main &&
  git push --force-with-lease=<branch>:<the SHA printed above> origin HEAD:<branch>
cd <scratchpad>/merge-<n> && bun install --frozen-lockfile
```

Both guards in the push line are load-bearing. The `&&` chain: a conflicted rebase
exits nonzero mid-rebase, and an unguarded push would overwrite the PR with that
partial history. The explicit `<branch>:<SHA>` lease: worktrees share refs, so any
concurrent fetch refreshes `origin/<branch>` and an expect-less lease would wave
through the loss of another session's push.

Resolve only conflicts that are mechanical, with unambiguous intent on both sides.
Anything where you'd be choosing behavior rather than reconciling text:
`git rebase --abort` and hand it back. This is the one failure the rest of the
pipeline cannot catch — the reviewer will find a misresolution perfectly coherent.

## 2. Adversarial review with fable

Spawn one subagent with the Agent tool, `model: "fable"`. Tell it the worktree
directory from step 1 (subagents start in the session cwd, not yours — an untold
reviewer diffs the wrong tree and reports nothing), the PR number and title, and the
target: `git diff origin/main...HEAD`. You are the author of the fixes; it is the
reviewer — a model reviewing its own fixes is not an adversarial review.

Instruct it to hunt for reasons this should **not** land ("looks good to me" is a
failed review), covering both defects — correctness, security, regressions, error
handling, concurrency, data loss — and the `check-invariants` skill's agent-pass
procedure. State explicitly that the diff base is `origin/main`, overriding that
skill's own `main...HEAD` — local `main` in this shared-ref repo is routinely stale.
Findings come back as `{file, line, severity: blocking|nit, claim, failure_scenario}`.

## 3. Triage, fix, repeat

Adversarial reviewers over-report — that's the cost of telling them to attack.
Confirm each finding against the actual code before acting, and say what you
discarded and why. Fix every surviving finding, `blocking` and `nit` alike, then
`bun run ci` (needs Docker for the LocalStack e2e lane), commit, push, and re-run
step 2 on the new diff. **At most 3 rounds** — if findings still survive, stop and
report.

## 4. Merge the reviewed tree

```bash
cd <scratchpad>/merge-<n> && git rev-parse HEAD     # the reviewed SHA — print it
gh pr checks <n> --watch &&
  gh pr merge <n> --merge --match-head-commit <the SHA printed above>
git push origin --delete <branch>
cd <primary checkout> && git worktree remove <scratchpad>/merge-<n>
```

If `gh pr checks` fails, stop and report — never merge red. The `&&` is the only
thing enforcing that: an admin token can merge over a failed required check here.
(`gh pr checks` also errors if GitHub hasn't registered the run yet — retry a few
times before believing it.) `--match-head-commit` refuses the merge if anything —
say, another agent session — touched the branch after the review; it pins the
branch head, not `main`. The final `cd` out matters too: removing the worktree
you're standing in strands the shell in a deleted directory.

Afterward, tell the user if a local checkout of `<branch>` exists anywhere
(`git worktree list`, `git branch`) — the remote it tracked is gone and its
history was rewritten.

Report the PR, rebase result, review rounds, findings fixed and discarded (with
why), and the final `main` SHA — or exactly where and why you stopped.
