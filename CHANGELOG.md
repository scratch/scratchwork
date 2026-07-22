# Changelog

Newest first. Maintained by hand per release; the release workflow copies the
top released section into the GitHub Release notes (scripts/release-notes.ts).

## Unreleased

## v0.3.0

- `npm create scratchwork-server` — new `create-scratchwork-server` package
  that scaffolds a standalone self-hosted server project
  (`--platform cloudflare | aws | local`). Templates are generated from the
  repo's `deploy/*` projects at pack time with `@scratchwork/*` dependencies
  pinned to the lockstep version, and every template is scaffolded and
  typechecked hermetically in ci.

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
