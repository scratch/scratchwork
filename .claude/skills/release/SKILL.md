---
name: release
description: Cut a Scratchwork release end to end — version bump PR, tag, GitHub Release, npm publish, homepage republish, install smoke test. Use when asked to release, ship, or cut vX.Y.Z.
---

# Release

Drive the release loop in `RELEASING.md` (the normative doc — read it first; if it
and this skill disagree, follow it and fix the drift in the same PR). One lockstep
version for the whole repo, one tag per release.

**Confirmation gates:** pushing the tag, publishing to npm, and republishing the
homepage are public and effectively irreversible. Pause and confirm with the user
before each one, unless they explicitly asked for an unattended release up front.
Everything else (branches, PRs, dry runs) proceeds without asking.

## Procedure

### 1. Preflight

- Start from a clean, up-to-date `main` (`git status`, `git pull`).
- Determine the version. If the user didn't give one, propose it from the
  `## Unreleased` section of `CHANGELOG.md` (breaking → minor while pre-1.0,
  otherwise patch) and confirm.
- `## Unreleased` must have real content; if it's empty, stop and ask what this
  release is.
- `gh auth status` and `npm whoami` must both succeed. Fail fast, not at step 5.

### 2. Bump PR

- Branch: `git checkout -b release-vX.Y.Z`.
- `bun scripts/set-version.ts X.Y.Z` (stamps root + every workspace).
- In `CHANGELOG.md`: retitle `## Unreleased` to `## vX.Y.Z` and add a fresh empty
  `## Unreleased` above it.
- `bun run ci` locally (enforces lockstep; requires Docker running for the e2e
  LocalStack lane).
- Commit, push, `gh pr create`. Watch CI with `gh pr checks --watch`.

### 3. Merge and tag

- **Gate:** confirm the user is ready to ship, then merge the PR
  (`gh pr merge --merge`), pull `main`, and verify HEAD carries the bump
  (`package.json` version is X.Y.Z).
- **Gate passed above covers the tag too:** `git tag vX.Y.Z && git push origin vX.Y.Z`.
- The tag triggers `.github/workflows/release.yml`. Watch it
  (`gh run watch --exit-status`); on success verify the Release exists with the four
  `*.tar.gz` archives + `checksums.txt`: `gh release view vX.Y.Z`.

### 4. npm publish

- Publish from a clean checkout of the tag, never the working tree. Use a scratch
  clone/worktree checked out at `vX.Y.Z` (the script itself refuses dirty trees and
  untagged HEADs).
- Dry-run first: `bun scripts/publish-packages.ts --dry-run` — review the five
  package names and the version.
- **Gate:** confirm, then `bun scripts/publish-packages.ts` — with npm 2FA, ask the
  user for a fresh authenticator code and pass `--otp <code>`. If a mid-sequence
  publish fails, report which packages went live and which didn't; already-published
  versions cannot be re-pushed, so the fix is forward (patch release), not retry.

### 5. Homepage republish

- **Gate:** confirm, then `scratchwork publish scratchwork.dev/www --project www --public`
  with production credentials, so `https://scratchwork.dev/install.sh` serves the current content.
  This needs an interactive `scratchwork login` against production — if not logged
  in, hand this step to the user rather than skipping it silently.

### 6. Smoke test

Run the real install path in a clean container (no Scratchwork, no repo):

```sh
docker run --rm debian:stable-slim sh -c '
  apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null &&
  curl -fsSL https://scratchwork.dev/install.sh | bash &&
  "$HOME/.local/bin/scratchwork" --version'
```

Pass = it prints `X.Y.Z`. If the homepage step was deferred, smoke against the
GitHub Release directly instead by setting `SCRATCHWORK_DOWNLOAD_BASE` to
`https://github.com/scratch/scratchwork/releases` inside the container.

## Report

End with: version shipped, PR and Release URLs, the five npm package versions,
whether the homepage was republished, and the smoke-test output. List any step that
was skipped or handed to the user — never imply an unfinished release is done.
