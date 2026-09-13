/*
 * The CLI release target matrix (decision 4 in notes/distribution-plan.md):
 * cross-compiled by `cd cli && bun build.js --all-targets`, packaged by
 * scripts/package-release.ts, and mapped from `uname` by scratchwork.dev/www/install.sh.
 * Windows and musl (Alpine) are explicit non-goals for v0.
 */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/**
 * The release archive name for one target. This is the naming contract that
 * install.sh and the CLI's `update` command (cli/src/commands/install.ts) both
 * parse out of checksums.txt; scripts/check-install-sh.ts builds its fixture
 * releases with it so drift in either parser fails the gate.
 */
export const releaseAssetName = (version: string, target: ReleaseTarget): string =>
  `scratchwork-v${version}-${target}.tar.gz`;
