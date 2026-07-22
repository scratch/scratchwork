# Releasing Scratchwork

One version for the whole repo (CLI binaries + npm packages), one tag per
release. Short enough to actually follow — or ask an agent to run the
`/release` skill (`.claude/skills/release/SKILL.md`), which drives this loop
with confirmation gates at the irreversible steps:

1. **Bump:** `bun scripts/set-version.ts X.Y.Z` (stamps root + every
   workspace; `bun run ci` enforces lockstep).
2. **Changelog:** retitle the `## Unreleased` section of `CHANGELOG.md` to
   `## vX.Y.Z` and start a fresh `## Unreleased` above it.
3. **PR + merge:** open a PR with the bump, let ci pass, merge to main.
4. **Tag:** `git tag vX.Y.Z && git push origin vX.Y.Z` on the merge commit.
   `.github/workflows/release.yml` runs the full gate, asserts the tag matches
   the lockstep version, cross-compiles the four CLI targets, and publishes
   the GitHub Release with archives + `checksums.txt` and the changelog
   section as notes.
5. **npm:** from a clean checkout of the tag, with an authenticated npm CLI:
   `bun scripts/publish-packages.ts` (add `--dry-run` first if in doubt;
   with npm 2FA, add `--otp <fresh code>`).
   Publishes `@scratchwork/shared`, `@scratchwork/server-core`, and the three
   `@scratchwork/server-deploy-*` packages in dependency order.
6. **Homepage:** republish the install entry points so
   `https://scratchwork.dev/install.sh` serves the current content:
   `scratchwork publish scratchwork.dev/www --project www --public` (with the
   production server credentials). Automating this in release.yml is a follow-up.
7. **Smoke:** on a machine (or clean container) without Scratchwork:
   `curl -fsSL https://scratchwork.dev/install.sh | bash` and check
   `scratchwork --version` prints X.Y.Z.

Fix this document in the same PR whenever reality disagrees with it.
