# 01 — Add authenticated publishing (auth + routing for server & CLI)

Status: **planned** (not started)

Add user authentication and per-user routing to the scratchwork server and CLI,
mirroring the auth/authorization model in `~/git/scratch/scratch` while keeping
external dependencies to an absolute minimum.

## Goals

- Users authenticate to the **app domain**; the CLI authenticates to the server
  the same way.
- Content is served at `/<user-slug>/<project-name>`; the project name is stored
  in `.scratchwork.json` in the project root.
- A visitor to a **protected** project is forced to authenticate via the app
  domain. Tokens are handled so that content served on the **pages/content
  domain cannot steal anything sensitive** (the cross-domain isolation that is
  the whole point of the split).

## Locked decisions

- **Platform:** Cloudflare Workers + D1 + R2 (prod); Bun + `bun:sqlite` +
  filesystem (local), behind the existing runtime-agnostic `handle(request)`
  pattern (`server/src/app.js`, `worker.js`, `local.js`).
- **Auth build:** mostly hand-rolled — D1 via raw SQL, routing extends the
  current dispatch, sessions/device-flow hand-rolled.
  - **Libs allowed:** `jose` (content-token + CF-Access JWT verification) and
    `zod` (input validation). **No** BetterAuth / Hono / kysely.
- **Auth modes:** both `local` (Google OAuth) and `cloudflare-access`, selected
  by `AUTH_MODE`.
- **User slug:** email local-part (`pete@ycombinator.com` → `pete`), with a
  uniqueness suffix on collision.
- **Access model:** full scratch parity — public / private / email + `@domain`
  groups / `MAX_VISIBILITY` ceiling / revocable share-link tokens.

## Architecture

### Two hostnames (dispatch by `Host`, like scratch's `index.ts`)

- **App domain** `app.<BASE_DOMAIN>` — `/auth/*`, `/api/*`, `/cli-login`,
  `/device`, UI. Issues session cookies scoped to this origin: **no `Domain`
  attribute**, `HttpOnly`, `Secure`, `SameSite=None` (HTTPS) / `Lax` (local).
- **Content domain** `pages.<BASE_DOMAIN>` — serves
  `/<user-slug>/<project-name>/…`. Untrusted; **never sees session cookies**.
  Private content is reachable only via the app-domain bounce plus a path-scoped
  content-token cookie.

### Irreducible security core (mirrored exactly from scratch)

- Private content → redirect to
  `app/auth/content-access?project_id=…&return_url=…` → app verifies session +
  `canAccessProject` → mints a **project-scoped HS256 JWT** (`jose`, signed with
  `AUTH_SECRET`; claims `sub`, `email`, `pid`, `aud=content`, `exp=1h`) →
  redirects back to the content domain with `?_ctoken=…`.
- Content domain verifies the JWT (signature + `pid` match + expiry), sets it as
  an **`HttpOnly`, `SameSite=Lax`, path=`/<owner>/<project>/`** cookie, then
  **302s to a clean URL** to strip the token from history / `Referer`.
- `return_url` must be on the content domain (open-redirect guard).
- Not-found vs. private projects are **indistinguishable** (synthetic-id trick).
- `/api` enforces `Origin` + `Content-Type`; `trustedOrigins` = app domain only
  (never the content domain).

## Data model (D1 + `bun:sqlite`, one schema)

- `user`(id, email unique, slug unique, name, image, created_at, updated_at)
- `account`(id, provider, provider_account_id, user_id) — OAuth linkage
- `session`(id, user_id, token unique, expires_at, user_agent, created_at,
  updated_at)
- `apikey`(id, user_id, name, prefix, key_hash, expires_at, last_used,
  created_at) — CI / non-interactive tokens
- `device_code`(id, device_code, user_code, user_id, status, expires_at,
  created_at) — CLI login handshake
- `project`(id, owner_id, name, visibility, live_deploy_id, version,
  last_deploy json, created_at, updated_at, **unique(owner_id, name)**)
- `share_token`(id, project_id, token unique, expires_at, revoked_at, created_at)

Deploy **blobs stay in R2/filesystem** (`deploys/<deployId>/<path>`). Project
metadata moves from R2 JSON into D1. Internal `project.id` is retained (needed
for the content-token `pid` and share tokens); the public URL uses
`slug/name`.

## CLI changes

- New/reworked commands: `login` (browser flow: localhost callback ←
  `app/cli-login?state&code`, stores session token in `credentials.json`, mode
  `0600`), `logout`, `whoami` (now reports user identity),
  `tokens create|list|revoke` (API keys for CI), `share create|list|revoke`.
- `publish` authenticates **as the user** (Bearer session token, or `X-Api-Key`
  from `SCRATCHWORK_TOKEN` for CI); project is keyed by name; server returns
  `https://pages.<base>/<slug>/<name>`.
- `.scratchwork.json` → `{ id, name, server }` (name is the URL slug per the
  requirement; `id` for stable identity across renames).
- `server-client.js` sends `Authorization: Bearer` (session) / `X-Api-Key`
  (key) / CF-Access headers as appropriate.

## Config / infra

- Env: `AUTH_MODE`, `BASE_DOMAIN`, `APP_SUBDOMAIN` (=`app`),
  `CONTENT_SUBDOMAIN` (=`pages`), `AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `CLOUDFLARE_ACCESS_TEAM`, `ALLOWED_USERS`,
  `MAX_VISIBILITY`, `ALLOW_SHARE_TOKENS`.
- `wrangler.toml`: add D1 binding (`DB`), keep R2 (`FILES`); secrets via
  `wrangler secret put`.
- `deploy.sh`: extend the one-command deploy to create the D1 db if missing,
  apply migrations, set secrets, then `wrangler deploy`.
- `shared/group.js`: port scratch's `parseGroup` / `matchesGroup` (pure,
  dependency-free). Reuse existing `shared/resolve.js` and `shared/bundle.js`
  unchanged.

## Build phases (each independently reviewable)

1. **Data layer** ✅ **done** — `schema.sql`, db abstraction (D1 + `bun:sqlite`
   adapters), migrations, wrangler/deploy wiring. See `server/src/db/`.
2. **App-domain user auth** — both modes, sessions, cookie, `getAuthenticatedUser`,
   login/logout UI.
3. **CLI auth** — `login`/`logout`/`whoami`/`tokens` + credentials + headers.
4. **Projects + content routing** — owner/name model, deploy-as-user,
   `/<slug>/<name>` serving via `resolve.js`.
5. **Authorization + content tokens** — visibility groups, `canAccessProject`,
   `/auth/content-access`, content-token cookie + URL stripping.
6. **Share tokens** — table, endpoints, content-serving checks.
7. **Config, `deploy.sh`, docs, tests.**

## Assumed defaults (change on request)

- Content domain is `pages.<base>` (not the bare domain).
- A single `AUTH_SECRET` signs content tokens; sessions are opaque DB tokens (no
  cookie signing needed).
- `.scratchwork.json` keeps an internal `id` alongside `name`.

## Reference

- Auth model being mirrored: `~/git/scratch/scratch` (BetterAuth + Hono + jose +
  kysely + D1). We replicate the **flows and security properties**, not the
  dependency stack.
