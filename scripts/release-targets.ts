/*
 * The CLI release target matrix (decision 4 in notes/distribution-plan.md):
 * cross-compiled by `cd cli && bun build.js --all-targets`, packaged by
 * scripts/package-release.ts, and mapped from `uname` by scratchwork.dev/install.sh.
 * Windows and musl (Alpine) are explicit non-goals for v0.
 */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
