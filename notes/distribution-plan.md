# Distributing Scratchwork: CLI binaries + npm packages

**Goal:** anyone can install the `scratchwork` CLI with one command and deploy their own
server from published packages:

1. CLI binaries versioned and released on GitHub Releases;
2. `https://scratchwork.dev/install.sh` (humans) and `https://scratchwork.dev/install.md`
   (agents) as the install entry points;
3. the server packages (`@scratchwork/shared`, `@scratchwork/server-core`,
   `@scratchwork/server-deploy-{aws,cloudflare,local}`) published to npm.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

## Where we are today

- **CLI:** `cli/build.js` compiles `src/index.ts` into a single self-contained binary
  (`bun build --compile`) with the renderer shell embedded — host platform only, no
  target matrix. Version comes from `cli/package.json` (`0.1.0`) via `import pkg from
  "../package.json"`, already wired to `scratchwork version`, `--version`, and `-v`.
  So the binary already embeds its version at build time; nothing new needed there.
- **Packages:** every workspace is `private: true` at `0.1.0`, inter-deps use
  `workspace:*`, and `exports` point at TypeScript source (`./src/*.ts`). Nothing is
  publishable as-is.
- **Automation:** the only workflow is `ci.yml` (exactly `bun run ci`). No release
  workflow, no tags, no changelog.
- **Docs already promise the endpoint:** `README.md` and `docs/index.md` both say
  `curl -fsSL https://scratchwork.dev/install.sh | bash`, but nothing produces or
  serves `install.sh`, and there are no releases to download.
- **scratchwork.dev is itself a published project.** The homepage domains serve an
  ordinary project (`homepageDomains`/`homepageProject`, see
  `deploy/cloudflare-vanilla`); `docs/` is the homepage content, published with
  `scratchwork publish`. So the install assets ship by adding files to `docs/` and
  republishing — no server change needed to host them.
- **Raw markdown serving already works:** requesting a `.md` path directly returns the
  raw markdown as `text/plain` (`RawMarkdownServed` in `shared/src/site/serve.ts`),
  while extensionless routes get the rendered shell. `install.md` therefore serves
  agent-readable raw markdown for free. `.sh` content-type needs verifying in
  `shared/src/site/content.ts` (any type works for `curl | bash`, but `text/plain`
  beats a download prompt for humans who open it in a browser).

## Decisions (recommendations inline; flag disagreement before Phase 1)

1. **Lockstep versioning.** One version for the whole repo: CLI binaries and all npm
   packages share it, and a git tag `vX.Y.Z` on main is the single release trigger.
   Independent per-package versions buy nothing at this stage and complicate the
   `workspace:*` story. Source of truth: the `version` field in each `package.json`,
   kept in lockstep by a version-bump script and a mechanized ci check.
2. **npm packages ship built JS + `.d.ts`, not TypeScript source.** (Pete, 2026-07-21;
   supersedes the earlier ship-TS-source recommendation.) Node deliberately refuses to
   type-strip files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
   so TS-source packages would be Bun/bundler-only — and users should be able to deploy
   with plain Node if they want. Each publishable package gets a `tsc` emit (ESM JS +
   declarations) into `dist/`, and the published `exports` point at `dist/`. In-repo
   development is unchanged: workspace resolution keeps consuming `src/*.ts` directly.
3. **What publishes where.** GitHub Releases: the CLI binary only. npm: `shared`,
   `server/core`, `server/deploy-aws`, `server/deploy-cloudflare`, `server/deploy-local`.
   Never published: `renderer` (embedded in the CLI), `deploy/*` (per-domain instances —
   they become the template users copy), `e2e`, the `server` tooling workspace.
4. **Cross-compile on one runner.** `bun build --compile --target=...` cross-compiles
   from a single Linux runner; no per-OS build matrix. Targets: `bun-darwin-arm64`,
   `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`. Windows and musl (Alpine)
   are explicit non-goals for v0; install.sh says so clearly when it can't match.
5. **Install destination `~/.local/bin`, no sudo.** Overridable with
   `SCRATCHWORK_INSTALL_DIR`; version pinnable with `SCRATCHWORK_VERSION`. The script
   never escalates privileges.

## Resolved questions (Pete, 2026-07-20)

- **Repo visibility:** `github.com/scratch/scratchwork` is public (verified via
  `gh repo view`), so GitHub Release assets are publicly downloadable — install.sh can
  fetch them directly.
- **npm scope:** Pete owns the `@scratchwork` org and the local npm CLI is
  authenticated (`npm whoami` → `koomen`, org owner). First releases publish from
  Pete's machine; moving publishing into the release workflow (granular `NPM_TOKEN` in
  Actions secrets) is a follow-up once the manual loop is boring.
- **macOS code signing:** unsigned binaries are accepted for v0. `curl | bash` installs
  don't set the quarantine attribute; revisit notarization only if browser downloads
  become a supported path.

## Plan

### Phase 1 — Version plumbing

`[x]` A `bun scripts/set-version.ts <x.y.z>` script that stamps `version` in the root
and every workspace `package.json` in lockstep. No other duty — tagging and changelog
stay manual and visible.

`[x]` Mechanized lockstep check in `bun run ci` (natural home: `check-boundaries.ts` or
a sibling script): every workspace `version` equals the root version. A drifted bump
fails the gate.

`[x]` `CHANGELOG.md` at root, maintained by hand per release, newest first. The release
workflow copies the top section into the GitHub Release notes.

Acceptance: `bun scripts/set-version.ts 0.2.0` updates every package.json; `bun run ci`
fails if any one is edited out of lockstep.

### Phase 2 — Cross-platform CLI builds + GitHub Release workflow

`[x]` Extend `cli/build.js` with a target matrix mode (e.g. `bun build.js --all-targets`):
builds the renderer once, then `bun build --compile --target=bun-<os>-<arch>` per target
into `cli/dist/scratchwork-<os>-<arch>`. Default (no flag) behavior stays exactly as
today so `bun run ci` cost doesn't change.

`[x]` `scripts/package-release.ts`: tars each binary as
`scratchwork-v<version>-<os>-<arch>.tar.gz` (binary named `scratchwork` inside) and
writes `checksums.txt` (SHA-256 of each archive). Tarball rather than bare binary so
the executable bit survives and the name inside is stable.

`[x]` `.github/workflows/release.yml`, triggered by tags matching `v*`:
1. checkout, pinned Bun, `bun install --frozen-lockfile`;
2. `bun run ci` (the same one gate — release never ships what ci wouldn't pass);
3. assert the tag matches the package.json version (fail loudly on mismatch);
4. build all targets, package, `gh release create` with archives + `checksums.txt`
   and the changelog section as notes.
`ci.yml` is untouched; the gate stays exactly `bun run ci`.

Acceptance: pushing tag `v0.2.0` produces a GitHub Release with four archives +
checksums, and `gh release download v0.2.0` on a mac yields a runnable binary that
prints `0.2.0` from `scratchwork --version`.

### Phase 3 — install.sh and install.md on scratchwork.dev

`[x]` `docs/install.sh` — POSIX sh, `set -euf`. Detects `uname -s`/`-m`, maps to a
release target (clear error for unsupported platforms, mentioning Windows/musl
explicitly), downloads from the stable no-API URL
`https://github.com/scratch/scratchwork/releases/latest/download/<asset>` (or the
pinned `SCRATCHWORK_VERSION`), verifies SHA-256 against `checksums.txt` (uses
`shasum -a 256` or `sha256sum`, whichever exists), installs to
`$SCRATCHWORK_INSTALL_DIR` (default `~/.local/bin`), and prints PATH guidance only when
the directory isn't on `$PATH`. Re-running upgrades in place. No sudo, ever.

`[x]` `docs/install.md` — the agent-facing page: what Scratchwork is (one paragraph),
the one-liner, the manual steps (exact URL pattern per platform, checksum verification,
chmod, PATH), version pinning, uninstall (`rm` one binary), and a pointer to
`scratchwork --help`. Written to be executed by an agent without fetching anything else.

`[x]` Verify/extend the `.sh` content-type mapping in `shared/src/site/content.ts`
(want `text/plain; charset=utf-8` or `text/x-shellscript`), with a serving test. Add a
test asserting a published `install.md` round-trips raw (the `RawMarkdownServed` path)
— that behavior is now load-bearing for distribution.

`[x]` Mechanized checks for the script itself inside `bun run ci`: `sh -n docs/install.sh`
(syntax) plus a unit test driving the platform-mapping + download against a local HTTP
fixture standing in for GitHub (same hermetic spirit as the e2e OAuth stand-in). No
network in ci.

`[x]` Release step: republish the homepage project after each release
(`scratchwork publish docs --project www ...`). Manual at first, listed in RELEASING.md;
automating it in release.yml (server credentials as secrets) is a follow-up once the
manual loop is boring.

Acceptance: with a release published, `curl -fsSL https://scratchwork.dev/install.sh | bash`
on clean macOS and Linux machines installs the latest binary and `scratchwork --version`
prints the released version; `curl https://scratchwork.dev/install.md` returns raw
markdown an agent can follow end-to-end.

### Phase 4 — npm packages

`[x]` A build step per publishable package: `tsc` emit of ESM JS + `.d.ts` into
`dist/`, driven by one shared script (`scripts/build-packages.ts` or per-package
`build`). Published `exports`/`types` point at `dist/`; in-repo `exports` keep pointing
at `src/*.ts` so workspace dev needs no build. Use `publishConfig` to swap the fields at
publish time (verify `bun publish`/`bun pm pack` applies `publishConfig.exports`; if
not, the release script rewrites package.json at pack time). `dist/` stays gitignored;
the release flow builds before packing.

`[x]` Make the five packages publishable: drop `private: true`; add `license`,
`repository` (with `directory`), `files` (dist + README, no tests or src), and a short
README each (what it is, works under Node ≥ 22 or Bun, minimal usage). Root,
`renderer`, `cli`, `server` (tooling), `deploy/*`, and `e2e` stay private.

`[x]` Verify `bun publish` rewrites `workspace:*` to the concrete lockstep version in
the published tarball (it should; check with `bun pm pack` + inspect). If it doesn't,
the release script rewrites versions at publish time.

`[x]` Dry-run check in ci or release workflow: build, then `bun pm pack` each
publishable package and assert the tarball contains `dist/` with `.js` + `.d.ts`, its
`exports` resolve to `dist/`, and it has no test files and no `workspace:` strings.

`[x]` A `scripts/publish-packages.ts` release step that runs `bun publish` for each
package in dependency order (shared → server-core → deploy adapters), refusing to run
on a dirty tree or when the checked-out tag doesn't match the lockstep version. Run
locally with Pete's authenticated npm CLI for the first releases. Follow-up (not this
plan): move it into `release.yml` with a granular `NPM_TOKEN` and `--provenance`
(free supply-chain attestation from Actions OIDC now that the repo is public).

`[x]` Consumer walkthrough in `server/README.md` (or `docs/`): "deploy your own" — a
fresh directory, `bun add @scratchwork/server-deploy-cloudflare`, copy the config shape
from `deploy/cloudflare-vanilla`, one command deploy. A `scratchwork server init`
scaffolder is explicitly future work, not this plan.

Acceptance: in a fresh directory outside the repo, `bun add
@scratchwork/server-deploy-cloudflare` + the documented config typechecks and deploys a
working server at the released version — and the same walkthrough works with plain
Node/npm (no Bun installed), since the packages are built JS.

### Phase 5 — Release process doc

`[x]` `RELEASING.md` at root: bump with `set-version.ts` → update `CHANGELOG.md` → PR →
merge → tag `vX.Y.Z` → workflow does the GitHub Release → run
`scripts/publish-packages.ts` locally for npm → republish homepage → smoke-test
install.sh from a clean machine. Short enough to actually be followed.

`[ ]` First real release: `v0.2.0` end-to-end, following RELEASING.md as written and
fixing the doc where reality disagrees.

## Discovered work (implementation, 2026-07-21)

Building Phase 4 surfaced prerequisites the plan hadn't named — all shipped in
the same PR:

- **Package-specifier imports.** server/core, the deploy packages, and the CLI
  imported shared via relative `../../../shared/src/...` paths, which escape
  the package root and can't publish. All cross-package imports now use
  `@scratchwork/shared/...` / `@scratchwork/server-core/...` specifiers with
  explicit workspace dependencies; shared's exports map is the pattern pair
  `"./*.js"`/`"./*"` → `src`, swapped to `dist` at staging time.
- **`.ts` import extensions.** Relative imports inside the five publishable
  packages carry explicit `.ts` extensions so tsc's
  `rewriteRelativeImportExtensions` can emit Node-runnable `.js` specifiers.
  tsc does not rewrite them in declaration output, so build-packages.ts
  post-processes the emitted `.d.ts`.
- **figure.svg module.** The Bun-only ``import ... with { type: "text" }``
  svg imports became a generated module
  (`shared/src/assets/figure-svg.generated.ts`, scripts/generate-assets.ts,
  freshness-checked in ci) so published code contains no loader-specific syntax.
- **Server tooling workspace dissolved.** `server/scripts/{env,proc,server-settings}.ts`
  were imported from published deploy `src/` via relative escapes; they moved
  into `server/core/src/deploy/` (published as
  `@scratchwork/server-core/deploy/*`), proc.ts was ported from Bun.spawn to
  node:child_process so deploys run under plain Node, and the now-empty
  `server` tooling workspace was removed.
- **LICENSE.** The repo had none; publishing requires one. Added MIT at the
  root (flagged in the PR for veto), `license`/`repository`/`engines` in the
  five package manifests.

## Invariant compliance notes

- Release/packaging scripts under `scripts/` and the workflow are deploy tooling —
  outside the Effect-boundary lint scope (`cli/src`, `server/**/src`, `shared/src`),
  same as the existing root scripts. `install.sh` is not TypeScript and lives in
  `docs/`, which is published content, deliberately outside the gate — but its syntax
  check and mapping test (Phase 3) run inside `bun run ci` so the gate still covers it.
- Any serving change for `.sh`/`.md` content types touches `shared/src/site` — plain
  mechanized-test territory (invariant 1 applies; no new async boundaries expected).
- No new auth surface, routes, or storage semantics anywhere in this plan
  (invariants 3–6 untouched).
