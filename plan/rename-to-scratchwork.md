# Rename Project: Scratch → Scratchwork

## Guiding Principles

1. **The CLI binary stays `scratch`** — users continue to type `scratch create`, `scratch dev`, `scratch build`, etc.
2. **The project/brand name becomes "Scratchwork"** — everywhere the product is described by name, it becomes Scratchwork.
3. **The domain becomes `scratchwork.dev`** (assumed) — all URL references to `scratch.dev` become `scratchwork.dev`.
4. **The GitHub repo becomes `scratchwork/scratchwork`** (assumed) — or whatever the new org/repo is.
5. **Internal code identifiers stay as-is where they're purely internal** — but namespaces/packages that carry the brand name change.

---

## Category 1: CHANGE — Brand/Project Name References

These are places where "Scratch" refers to the product name and should become "Scratchwork".

### 1.1 Package Names (5 files)

| File | Current | New |
|------|---------|-----|
| `package.json` | `"name": "scratch"` | `"name": "scratchwork"` |
| `cli/package.json` | `"name": "scratch"` | `"name": "scratchwork"` |
| `server/package.json` | `"name": "scratch-server"` | `"name": "scratchwork-server"` |
| `shared/package.json` | `"name": "@scratch/shared"` | `"name": "@scratchwork/shared"` |
| `website/package.json` | `"name": "scratch.dev"` | `"name": "scratchwork.dev"` |

### 1.2 Import Paths (~25 import statements across ~15 files)

All `@scratch/shared` imports become `@scratchwork/shared`:

- `@scratch/shared` → `@scratchwork/shared`
- `@scratch/shared/project` → `@scratchwork/shared/project`
- `@scratch/shared/api` → `@scratchwork/shared/api`
- `@scratch/shared/visibility` → `@scratchwork/shared/visibility`

**Files to update:**
- `cli/src/config/prompts.ts`
- `cli/src/cmd/cloud/publish.ts`
- `cli/src/cmd/cloud/share.ts`
- `cli/src/cmd/cloud/defaults.ts`
- `cli/src/cloud/api.ts`
- `server/src/routes/pages.ts`
- `server/src/routes/app/api/deploys.ts`
- `server/src/routes/app/api/share-tokens.ts`
- `server/src/routes/app/api/projects.ts`
- `server/src/lib/cache.ts`
- `server/src/lib/share-tokens.ts`
- `server/src/lib/visibility.ts`
- `server/src/lib/api-helpers.ts`
- `server/src/lib/access.ts`
- `server/test/www-mode.test.ts`
- `cli/test/unit/cloud/config.test.ts`

### 1.3 Domain/URL References (~150+ instances)

| Old Domain | New Domain |
|------------|-----------|
| `scratch.dev` | `scratchwork.dev` |
| `app.scratch.dev` | `app.scratchwork.dev` |
| `pages.scratch.dev` | `pages.scratchwork.dev` |
| `staging.scratch.dev` | `staging.scratchwork.dev` |
| `cdn.scratch.dev` | `cdn.scratchwork.dev` |

**Key files:**
- `cli/src/config/paths.ts` — `DEFAULT_SERVER_URL`
- `cli/template/_config/global.toml` — default server URL
- `cli/template/_config/project.toml` — commented server URL
- `website/.scratch/project.toml` — project server URL
- `website/pages/docs.mdx` — all documentation URLs (~30+)
- `website/pages/index.mdx` — homepage URLs
- `website/pages/install.md` — installation URLs
- `website/public/install.sh` — install script URLs
- `website/public/_redirects` — redirect URLs
- `cli/src/template.generated.ts` — embedded template URLs
- `server/.scratch-dev.vars` — `BASE_DOMAIN` and `CLOUDFLARE_ZONE`
- All test files with hardcoded `scratch.dev` URLs (~50+ instances across test files)

### 1.4 GitHub Repository References

| Old | New |
|-----|-----|
| `scratch/scratch` | `scratchwork/scratchwork` |
| `github.com/scratch/scratch` | `github.com/scratchwork/scratchwork` |

**Files:**
- `cli/src/version.ts` — `export const REPO = 'scratch/scratch'`
- `website/src/template/Header.jsx` — GitHub link
- `website/public/install.sh` — `REPO="scratch/scratch"`
- `website/public/_redirects` — raw.githubusercontent.com link
- `website/pages/install.md` — GitHub API URLs
- `website/pages/docs.mdx` — GitHub clone URL
- `website/pages/index.mdx` — "Scratch repo" link
- `cli/src/template.generated.ts` — embedded GitHub URLs
- `.github/workflows/cli-release.yml` — implicitly via repo context

### 1.5 User-Facing Brand Strings in Code

All "Scratch" (capitalized, as product name) → "Scratchwork":

**CLI messages (`cli/src/`):**
- `cmd/build.ts:22` — "Building Scratch project" → "Building Scratchwork project"
- `cmd/create.ts:58-60` — "Created a new Scratch project" → "Created a new Scratchwork project"
- `cmd/cloud/config.ts:40` — "Run this command from a Scratch project directory"
- `index.ts:75` — "Create a new Scratch project"
- `index.ts:194` — "Build and publish project to a Scratch server"
- `index.ts:219` — "Log in to a Scratch server"
- `index.ts:231` — "Log out from a Scratch server"
- `index.ts:254` — "Manage projects on a Scratch server"
- `index.ts:419` — "Update scratch to the latest version"
- `cloud/api.ts:2` — "Scratch Cloud API client"
- `cloud/request.ts:2` — "HTTP request utilities for the Scratch Cloud API"
- `config/project-config.ts:9-12` — TOML header comments ("Scratch Cloud Project Configuration")
- `config/global-config.ts:9-12` — TOML header comments ("Scratch Global Configuration")
- `config/index.ts:1` — "Unified config library for Scratch"
- `cmd/cloud/ui.ts:44,58` — HTML page titles ("Authentication Successful - Scratch")

**Server UI (`server/src/`):**
- `lib/ui.ts:65,79,112,126,144` — HTML page titles ("Scratch", "Error - Scratch", "Authorize Device - Scratch")
- `lib/ui-logo.ts:2,7` — Comments about the logo

**Ops (`ops/`):**
- `index.ts:15` — "Scratch ops CLI"
- `commands/website.ts:22` — "Website (https://scratch.dev) commands"
- `commands/cli.ts:58` — "Build the scratch CLI"

### 1.6 Logo and Branding Assets

**SVG logos (text says "Scratch" → "Scratchwork"):**
- `cli/template/public/scratch-logo.svg` → rename to `scratchwork-logo.svg`, update text
- `website/public/scratch-logo.svg` → rename to `scratchwork-logo.svg`, update text
- `website/public/scratch.svg` — large illustration (may need text update)
- `website/public/scratch-social.png` — social media image (needs regeneration)
- `server/src/lib/ui-logo.ts` — inlined SVG string (update text)

**References to logo filename:**
- `cli/src/template.generated.ts` — multiple references to `scratch-logo.svg`
- `cli/template/src/template/ScratchBadge.jsx` — `scratch-logo.svg`
- `website/src/template/ScratchBadge.jsx` — `scratch-logo.svg`
- `website/src/template/Header.jsx` — `scratch-logo.svg`
- `website/pages/index.mdx` — `![Scratch logo](/scratch-logo.svg)`
- `website/pages/docs.mdx` — social image reference
- `README.md` — logo reference
- `cli/README.md` — logo reference

### 1.7 Component Names (ScratchBadge → ScratchworkBadge)

- `cli/template/src/template/ScratchBadge.jsx` → rename file to `ScratchworkBadge.jsx`
- `cli/template/src/template/Footer.jsx` — import ScratchBadge
- `website/src/template/ScratchBadge.jsx` → rename file to `ScratchworkBadge.jsx`
- `website/src/template/Footer.jsx` — import ScratchBadge
- `cli/src/template.generated.ts` — all generated references

### 1.8 Documentation Files

**Root:**
- `README.md` — all brand references
- `CLAUDE.md` — all brand references

**CLI:**
- `cli/README.md` — all brand references
- `cli/CLAUDE.md` — brand references
- `cli/CHANGELOG.md` — brand references (many)
- `cli/template/AGENTS.md` — brand references

**Server:**
- `server/CLAUDE.md` — brand references
- `server/CHANGELOG.md` — brand references

**Website:**
- `website/CLAUDE.md` — brand references
- `website/pages/index.mdx` — entire homepage
- `website/pages/docs.mdx` — entire docs page
- `website/pages/install.md` — installation page
- `website/notes.md` — planning notes

**Skills:**
- `.claude/skills/ops/SKILL.md` — brand references
- `.claude/skills/cli-dev/SKILL.md` — brand references

### 1.9 Wrangler/Cloudflare Resource Names

- `server/wrangler.template.toml` — `${INSTANCE}-scratch-server` → `${INSTANCE}-scratchwork-server`
- `server/wrangler.template.toml` — `${INSTANCE}-scratch-files` → `${INSTANCE}-scratchwork-files`
- `server/wrangler.template.toml` — `${INSTANCE}-scratch-db` → `${INSTANCE}-scratchwork-db`
- `ops/lib/config.ts:231-233` — matching resource name templates
- `ops/commands/server/setup.ts:159-161` — matching resource name templates
- `ops/test/db.test.ts:22-24` — test fixture names

### 1.10 JWT Issuer & User Agent

- `server/src/lib/content-token.ts:13` — `ISSUER = 'scratch'` → `'scratchwork'`
- `server/src/lib/session.ts:14,33` — user agent `'scratch-cli'` → `'scratchwork-cli'`

### 1.11 API Token Prefix

- `server/src/auth.ts:77` — `defaultPrefix: 'scratch_'` → `defaultPrefix: 'scratchwork_'`
- `cli/src/cmd/cloud/tokens.ts:218-219` — validation `startsWith('scratch_')` → `startsWith('scratchwork_')`
- `cli/src/index.ts:382` — help text "(starts with scratch_)"
- All token example strings in docs/auth messages
- Test files with `scratch_` test tokens

**NOTE:** This is a breaking change for existing API tokens. Consider accepting both prefixes during a transition period.

### 1.12 Environment Variables

- `SCRATCH_TOKEN` → `SCRATCHWORK_TOKEN`
- `SCRATCH_SERVER_URL` → `SCRATCHWORK_SERVER_URL`

**NOTE:** These are breaking changes. Consider accepting both during a transition.

### 1.13 Install Script

- `website/public/install.sh` — Binary name stays `scratch`, but repo/URL references change

---

## Category 2: CHANGE — Directory/File Path References

### 2.1 Config Directories

| Old | New |
|-----|-----|
| `~/.scratch/` | `~/.scratchwork/` |
| `~/.scratch/credentials.json` | `~/.scratchwork/credentials.json` |
| `~/.scratch/cf-access.json` | `~/.scratchwork/cf-access.json` |
| `~/.scratch/cache/` | `~/.scratchwork/cache/` |
| `~/.config/scratch/` | `~/.config/scratchwork/` |
| `~/.config/scratch/config.toml` | `~/.config/scratchwork/config.toml` |
| `.scratch/` (project dir) | `.scratchwork/` |
| `.scratch/project.toml` | `.scratchwork/project.toml` |
| `.scratch/cache/` | `.scratchwork/cache/` |
| `.scratch/dev/` | `.scratchwork/dev/` |

**Key files to update:**
- `cli/src/config/paths.ts` — all path definitions (lines 8-19)
- `cli/src/build/context.ts:49` — temp dir path
- `cli/src/index.ts:161-162` — clean command paths
- `cli/src/index.ts:586-589` — dev output dir
- `cli/src/cmd/watch.ts:12,65-66` — cache dir
- `cli/template/.gitignore` — `.scratch/*` patterns
- `website/.gitignore` — `.scratch/*` patterns
- All test files referencing `.scratch/` paths (~30+ instances)
- All documentation referencing `.scratch/` paths

### 2.2 Temp Directory Prefixes

- `cli/src/cmd/watch.ts:37` — `scratch-watch-` → `scratchwork-watch-`
- `cli/src/cmd/update.ts:127` — `scratch-downloads` → `scratchwork-downloads`
- `ops/commands/server/test/context.ts:87` — `scratch-${instance}-test-` → `scratchwork-${instance}-test-`
- `ops/commands/server/test/content-token.ts:18` — similar temp dir prefix
- `ops/commands/server/test/share-token.ts:24` — similar temp dir prefix
- `ops/commands/server/test/api-token.ts:59` — `scratch-env-test-` → `scratchwork-env-test-`

### 2.3 Binary File Names (in build scripts)

The binary stays named `scratch`, but platform-specific builds reference it:
- `cli/package.json` — `scratch-darwin-arm64`, `scratch-linux-x64`, etc.
- `.github/workflows/cli-release.yml` — `scratch-*` binary patterns

**Decision: Keep as `scratch-*`** since the CLI binary name stays `scratch`.

---

## Category 3: DO NOT CHANGE — CLI Command Name

The CLI executable stays `scratch`. These should NOT be changed:

- `cli/package.json` `"bin": { "scratch": "src/index.ts" }` — **KEEP**
- `cli/src/index.ts:37` `.name('scratch')` — **KEEP**
- All user-facing messages showing CLI commands: `scratch create`, `scratch dev`, `scratch build`, `scratch publish`, etc. — **KEEP**
- `website/pages/docs.mdx` code blocks showing `scratch <command>` — **KEEP**
- `cli/template/AGENTS.md` CLI command references — **KEEP**
- `website/CLAUDE.md` CLI command references — **KEEP**
- `ops/commands/website.ts:8` — `Bun.spawn(['scratch', cmd, ...args]` — **KEEP**
- `ops/commands/server/test/context.ts:11` — `CLI_BIN = './cli/dist/scratch'` — **KEEP**
- Install script binary name `BINARY_NAME="scratch"` — **KEEP**
- Build output filenames `dist/scratch`, `dist/scratch-darwin-arm64`, etc. — **KEEP**
- `.github/workflows/cli-release.yml` binary patterns — **KEEP**

---

## Category 4: DO NOT CHANGE — Internal Code Identifiers

These are internal variable/function names that don't surface to users:

- `__SCRATCH_BASE__` — **KEEP** (would break existing deployed sites, purely internal global)
- `__SCRATCH_SSG__` — **KEEP** (same reason)
- `window.__scratch_author__` — **KEEP** (internal runtime global)
- `ScratchGlobals` interface — **KEEP** (internal TypeScript type)
- `generateGlobalsScript()`, `generateGlobalsAssignment()` — **KEEP**
- `scratchGlobals` template variable — **KEEP**
- `scratchPath` in test files — **KEEP** (local test variable)
- `scratchDir` in config code — **KEEP** (local variable)
- `runScratchCommand` in ops — **KEEP** (internal function)
- `STORAGE_KEY = "scratch-demo-todos"` — **KEEP** (localStorage key in demo)

**Rationale:** These are implementation details. Renaming them adds churn without user-visible benefit and risks breaking deployed sites that reference `__SCRATCH_BASE__`.

---

## Category 5: NEEDS DECISION

### 5.1 API Token Prefix Migration

The `scratch_` prefix is baked into existing tokens in production databases. Options:
- **Option A:** Change to `scratchwork_` and accept both `scratch_` and `scratchwork_` during transition
- **Option B:** Keep `scratch_` prefix permanently (simpler, no migration needed)

**Recommendation:** Option A with backward compatibility.

### 5.2 Environment Variable Migration

`SCRATCH_TOKEN` and `SCRATCH_SERVER_URL` may be in users' CI/CD configs.
- **Option A:** Change to `SCRATCHWORK_TOKEN` / `SCRATCHWORK_SERVER_URL` and accept both
- **Option B:** Keep the old names

**Recommendation:** Option A with backward compatibility (check new name first, fall back to old).

### 5.3 Internal Globals (`__SCRATCH_BASE__`, etc.)

- **Option A:** Rename to `__SCRATCHWORK_BASE__` (clean but breaks existing sites)
- **Option B:** Keep as `__SCRATCH_BASE__` (pragmatic, no breakage)

**Recommendation:** Option B. These are never seen by users.

### 5.4 Config Directory Names

`~/.scratch/` and `.scratch/` contain user data and project config. Renaming them would break existing projects.
- **Option A:** Rename directories, add migration logic to detect and move old paths
- **Option B:** Keep old directory names

**Recommendation:** Option A with migration. On first run, if `~/.scratch/` exists but `~/.scratchwork/` doesn't, move it. Same for `.scratch/` → `.scratchwork/` in projects.

---

## Execution Order

### Phase 1: Package & Import Infrastructure
1. Rename `@scratch/shared` → `@scratchwork/shared` in `shared/package.json`
2. Update all import paths across server and CLI
3. Update root `package.json` name
4. Update `cli/package.json` name (keep bin as `scratch`)
5. Update `server/package.json` name
6. Update `website/package.json` name

### Phase 2: Config & Path Changes
7. Update `cli/src/config/paths.ts` — all directory paths (`.scratch` → `.scratchwork`)
8. Update `cli/src/build/context.ts` — cache dir
9. Update `cli/src/index.ts` — clean command, dev output dir
10. Update `cli/src/cmd/watch.ts` — cache dir
11. Update all `.gitignore` files
12. Update template config files (global.toml, project.toml)
13. Update `website/.scratch/` → `website/.scratchwork/`
14. Add migration logic for old config directories

### Phase 3: Domain & URL Changes
15. Update `cli/src/config/paths.ts` — `DEFAULT_SERVER_URL`
16. Update all hardcoded `scratch.dev` → `scratchwork.dev` URLs
17. Update `server/.scratch-dev.vars` → `server/.scratchwork-dev.vars`
18. Update `cli/src/version.ts` — repo name
19. Update wrangler template — resource names
20. Update ops config — resource names

### Phase 4: Branding & UI
21. Update/recreate logo SVGs (text "Scratch" → "Scratchwork")
22. Rename logo files: `scratch-logo.svg` → `scratchwork-logo.svg`
23. Rename `ScratchBadge.jsx` → `ScratchworkBadge.jsx` (template + website)
24. Update `server/src/lib/ui-logo.ts` — inlined SVG
25. Update `server/src/lib/ui.ts` — page titles
26. Update `cli/src/cmd/cloud/ui.ts` — page titles
27. Regenerate `scratch-social.png` → `scratchwork-social.png`

### Phase 5: User-Facing Strings
28. Update all CLI command descriptions and log messages
29. Update all config file header comments
30. Update server JWT issuer and user agent string

### Phase 6: API Token & Env Vars (with backward compat)
31. Update `server/src/auth.ts` — token prefix with backward compat
32. Update `cli/src/cmd/cloud/tokens.ts` — token validation with backward compat
33. Update env var names with backward compat (`SCRATCH_TOKEN` → `SCRATCHWORK_TOKEN`)

### Phase 7: Documentation
34. Update `README.md`
35. Update `cli/README.md`
36. Update `CLAUDE.md` (root)
37. Update `cli/CLAUDE.md`
38. Update `server/CLAUDE.md`
39. Update `website/CLAUDE.md`
40. Update `cli/CHANGELOG.md` (add rename note, don't rewrite history)
41. Update `server/CHANGELOG.md`
42. Update `.claude/skills/` files
43. Update `cli/template/AGENTS.md`

### Phase 8: Website Content
44. Update `website/pages/index.mdx`
45. Update `website/pages/docs.mdx`
46. Update `website/pages/install.md`
47. Update `website/notes.md`
48. Update `website/src/template/` components

### Phase 9: Template & Generated Code
49. Update `cli/template/` source files
50. Regenerate `cli/src/template.generated.ts` (or update manually)

### Phase 10: Tests
51. Update all test files with domain references
52. Update test fixtures with config paths
53. Update test assertions for new brand name
54. Run full test suite to verify

### Phase 11: Ops & CI
55. Update ops config and test files
56. Update `.github/workflows/cli-release.yml` (if repo name changes)
57. Update install script

### Phase 12: Infrastructure (out of scope for code changes)
58. Register `scratchwork.dev` domain
59. Set up DNS for app/pages/staging subdomains
60. Create new GitHub org/repo or rename existing
61. Update Cloudflare Workers/D1/R2 resource names
62. Migrate existing user data

---

## File Count Summary

| Category | Estimated Files |
|----------|----------------|
| Package/import changes | ~20 |
| Config/path changes | ~15 |
| Domain/URL changes | ~40 |
| Logo/branding | ~10 |
| User-facing strings | ~15 |
| Documentation | ~15 |
| Website content | ~8 |
| Template/generated | ~5 |
| Tests | ~30 |
| Ops/CI | ~10 |
| **Total** | **~170 files** |

## Risk Assessment

- **Breaking change: API tokens** — Existing `scratch_` tokens won't validate if we don't add backward compat
- **Breaking change: Config directories** — Existing `~/.scratch/` and `.scratch/` directories need migration
- **Breaking change: Env vars** — Users with `SCRATCH_TOKEN` in CI need to update
- **Breaking change: Cloudflare resources** — Workers, D1, R2 bucket names change
- **Non-breaking: CLI command** — `scratch` stays as the command name
- **Non-breaking: Internal globals** — `__SCRATCH_BASE__` etc. stay the same
