# Changelog

Newest first. Maintained by hand per release; the release workflow copies the
top released section into the GitHub Release notes (scripts/release-notes.ts).

## Unreleased

## v0.2.0

- Distribution: cross-platform CLI binaries on GitHub Releases, `install.sh` /
  `install.md` served from scratchwork.dev, and the server packages
  (`@scratchwork/shared`, `@scratchwork/server-core`,
  `@scratchwork/server-deploy-{aws,cloudflare,local}`) published to npm as
  built JS + type declarations.

## v0.1.0

- Pre-distribution baseline: the `scratchwork` CLI (dev server, publish,
  share), the single-file Markdown renderer, and the publishing server for
  local, AWS, and Cloudflare deploy targets.
