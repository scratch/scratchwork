# Changelog

All notable changes to the Scratch Server will be documented in this file.

## [0.2.4] - 2026-02-01

This release completes the removal of the namespace column from the database schema.

### Improvements

- **Database cleanup**: Removed the deprecated `namespace` column from the projects schema and related queries. This finalizes the transition to owner-based project URLs introduced in v0.1.1. Existing databases will have the column ignored; new databases won't create it.

## [0.2.3] - 2026-02-01

This release focuses on internal code quality improvements and adds comprehensive unit tests without changing user-facing functionality.

### Improvements

- **Code simplification**: Consolidated duplicated patterns across API routes, reducing ~350 lines of redundant code. Extracted reusable helpers for cache invalidation, SQL query building, session creation, visibility validation, and URL redirects.
- **Database schema cleanup**: Migrated to unified `schema.d1.sql` with idempotent `IF NOT EXISTS` statements. Removed fake transaction support from DbClient (D1's single-writer model handles concurrency).
- **Content serving refactored**: Split large authentication function into focused, single-responsibility helpers for content token and share token authentication.
- **Share token middleware**: Consolidated feature flag check into middleware instead of repeating in each endpoint.
- **UI components extracted**: Moved CSS and logo SVG into separate modules for better maintainability.

### Testing

- Added 170+ unit tests across 12 new test files covering cache helpers, API helpers, URL helpers, session creation, redirects, and more.

## [0.2.2] - 2026-01-31

This release adds API token support for CI/CD workflows and improves security for private content handling.

### Features

- **API tokens**: Create long-lived tokens for programmatic access without interactive login. Tokens use the `X-Api-Key` header and work in both standard and Cloudflare Access auth modes. Manage tokens via `scratch tokens ls|create|revoke|use` CLI commands.
- **Project rename support**: Projects can now be renamed by changing the name in `project.toml`. The server tracks projects by ID, so renames are detected and applied during publish.

### Security

- **Non-existent projects redirect to auth**: Previously, non-existent projects returned 404 which allowed attackers to distinguish "doesn't exist" from "private". Now they redirect to auth like private projects do.
- **Token URL cleanup**: Content tokens and share tokens passed in URLs are now cleaned via server-side redirect after setting cookies. This removes tokens from browser history and prevents leakage via Referer headers.
- **API tokens isolated from content domain**: API tokens are explicitly rejected on the content domain, preventing malicious user-uploaded JS from using stolen tokens.

### Improvements

- **Runtime environment validation**: Server now validates required environment variables at startup based on auth mode, providing clear error messages for missing configuration.
- **Additional MIME types**: Added support for `.mdx` and `.sh` files served as `text/plain`.
- **.mdx to .md redirects**: URLs ending in `.mdx` automatically redirect to `.md` (since the CLI renames `.mdx` files during build).
- **Bearer token support for content-access endpoint**: Enables CLI-based testing of private content access flows.

## [0.2.1] - 2026-01-18

This release adds support for serving a project on the www subdomain and root domain.

### Features

- **Root domain project hosting**: A project can now be served at both `www.example.com` and `example.com` by setting the `WWW_PROJECT_ID` environment variable. This is useful for hosting a primary marketing site or landing page directly on the root domain.

### Improvements

- Refactored content serving logic into a shared `content-serving.ts` module, reducing code duplication between the pages and www route handlers

## [0.2.0] - 2026-01-14

Initial release of Scratch Server as part of the monorepo structure. The server is a Cloudflare Worker that powers the Scratch Cloud platform.

### Features

- **Project hosting**: Deploy static MDX sites to the cloud with versioned deploys and instant rollback capability
- **Owner-based URLs**: Projects are served at `/{owner}/{project}/` paths, with owners identified by user ID, email, or email local part
- **Dual authentication**: Supports both Google OAuth (via BetterAuth) and Cloudflare Access for flexible deployment options
- **CLI device flow**: RFC 8628-based device authorization for secure CLI authentication
- **Privacy controls**: Configurable project visibility (public, private, domain-restricted) with content tokens for secure private content access
- **Share tokens**: Optional time-limited anonymous share URLs for projects
- **Access control**: Configure allowed users via email addresses, domains, or public access

### Architecture

- Cloudflare D1 database for user, session, and project metadata
- Cloudflare R2 storage for deployed static files
- Domain-based routing with isolated authentication between app and content subdomains
- Shared TypeScript types between server and CLI via `@scratch/shared` package

## [0.1.2] - 2026-01-14

This release simplifies CLI authentication by replacing the device code flow with a streamlined browser-based login.

### Improvements

- **Simplified CLI authentication**: Replaced the RFC 8628 device code flow with a simpler browser-based flow. The CLI now opens a browser directly to `/cli-login` where users verify a short code and approve the login. This eliminates polling logic, reduces complexity, and works seamlessly with both BetterAuth and Cloudflare Access authentication modes.

## [0.1.1] - 2026-01-14

This release simplifies project URLs by replacing namespaces with owner-based paths, and improves Cloudflare Access authentication for CLI users.

### Features

- **Simplified project URLs**: Projects are now accessed via owner identifier instead of namespace (e.g., `/pete/my-app/` or `/user123/my-app/`). Owner can be identified by user ID, email, or email local part (when a single domain is configured in `ALLOWED_USERS`).
- **Streamlined CLI login for Cloudflare Access**: Added `/cli-login` endpoint that bypasses the device code flow when using Cloudflare Access authentication, directly authenticating and redirecting to the CLI.
- **Auto-approve device flow in CF Access mode**: The `/device` endpoint now automatically approves and redirects to localhost callback when `AUTH_MODE=cloudflare-access`, eliminating the manual approval step.

### Improvements

- Added support for `cf-access-token` header for CLI requests behind Cloudflare Access
- Bearer token authentication now works correctly in Cloudflare Access mode by directly querying the session database
- Added `CLOUDFLARE_ACCOUNT_ID` to configuration template for multi-account deployments

### Breaking Changes

- Removed namespace concept from projects - projects are now uniquely identified by name + owner
- Project URLs changed from `/{namespace}/{project}/` to `/{owner}/{project}/`
- Removed `GLOBAL_NAMESPACE_URL` configuration option
- API responses now return `urls` object with `primary` and `byId` URLs instead of single `url` field
- Database schema changed: `projects` table no longer has `namespace` column, now uses `owner_id` for uniqueness
