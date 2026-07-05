# Plan: remove workspaces from Scratchwork

Projects are currently namespaced as `workspace/project`. This plan removes the workspace
concept entirely: a project is identified by a single, server-globally-unique **project
name**. The public URL is `https://<contentDomain>/<project>/…`, the DB key is the project
name, the cookie path is `/<project>`, and the API path segment is the project name.

All spec references are to the **committed** `notes/spec.md` (`git show HEAD:notes/spec.md`).
The working tree carries an uncommitted homepage-feature draft in that file and an untracked
prior plan (`notes/remove-workspaces-codex.md`); both are out of scope. The spec edits in §9
apply on top of the committed text, and the homepage draft must be rebased over them by its
author — do not merge blind. Any repo-wide "workspace" grep will hit both of those files.

## 1. Design decisions (normative — everything below is decided except the one confirmation at the end)

| Concern | Decision |
|---|---|
| Project identity | One globally-unique name per server. Grammar tightened to lowercase: `/^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/` (see D-grammar below). |
| Naming mode | New config `projectNaming: "user" \| "random"`, env `SCRATCHWORK_PROJECT_NAMING`, default `"user"`. Replaces `projectRoutingMode`, `defaultWorkspace`, and `usersCanCreateWorkspaces` outright. `userDomain` routing is deleted with no successor. |
| CLI default name | Directory publish → directory name, slugified. Single-file publish → file name minus its final extension, slugified. `--project` overrides. The CLI always sends a name when it can derive one; it never needs to know the server's naming mode. |
| Random-mode semantics | A client-sent name is honored only as an **update key** for a project the caller already owns (this is how republish works — the CLI echoes the slug saved in `.scratchwork.json`). Any other create mints `randomSlug()`. No new protocol field; the CLI prints a note when the returned name differs from the sent one and always saves `response.project`. |
| Collisions | 409 with one canonical message: `Project name "<name>" is already taken on this server. Choose another with --project.` Used both for the load-time check and for the create race (`PrimitiveDbConflict` must be caught and mapped — never surface the raw `Record already exists: <key>` DB message). The existence leak to authenticated users is accepted: names are public URL segments. |
| Uniqueness claim | The `ifNoneMatch: "*"` put of the project record (key = bare name) is the **single** uniqueness claim. The routes DB namespace, `RouteRecord`, and the two-phase claim/rollback in `writeNewProject` are deleted. One write, no rollback dance, one fewer DB hop per content request. |
| `routePath` | Deleted everywhere (DB records, API responses, `.scratchwork.json`, spec). It always equals the project name; a field that is always derivable is a field that can silently disagree. |
| `/api/resolve` | Deleted (endpoint + CLI consumer). Route ≡ project name in both modes, so URL→project is a local parse of the first path segment. |
| Access tokens | `ProjectAccessPayloadSchema` collapses to one `project` field — **rename** `projectKey` → `project` (Effect Schema ignores excess properties by default, so the rename is what guarantees old cookies fail decode). **No `SESSION_VERSION` bump**: session tokens don't change shape; stale access cookies fail decode and re-run the handoff (`app.ts:404` and `app.ts:430` already wrap verification in `orElseSucceed(() => null)` → redirect, not 500 — verify this during implementation). |
| Reserved names | Extend `RESERVED_ROUTE_SLUGS` to: `api`, `auth`, `health`, `favicon.ico`, `favicon.svg`, **`robots.txt`, `sitemap.xml`, `ads.txt`, `app-ads.txt`, `security.txt`**. Under single-segment routing a project named `robots.txt` would control crawl policy for the whole content host; these root files are host-wide and names are permanent once claimed. `.well-known` needs no entry (leading `.` is not a valid identifier). Reservation stays server-side in `access.ts` — it is route policy, not identifier grammar, and the CLI must not hardcode it. |
| Old-client compatibility | **Hard break.** `RawPublishRequestSchema` keeps `onExcessProperty: "error"`, so an old CLI sending `workspace` gets a 400 naming the field; old `/api/projects/:ws/:proj` paths 404. Pre-release, single-team tool; no tolerance window. |
| Existing data | **Wipe, don't migrate.** Record version literals are bumped so any stragglers fail loudly. Rejected alternative (not built): a one-shot key-flattening script that would also have to resolve `<wsA>/<p>` vs `<wsB>/<p>` collisions with no automatic answer. |
| Bundle format | `PUBLISH_BUNDLE_VERSION` unchanged — the bundle never carried identity; the protocol break is enforced by the request schema. |

**D-grammar (small rider, decided):** tighten `isSafeProjectIdentifier` to
`/^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/` — lowercase only, first/last char alphanumeric,
max 128 chars. Rationale: under global uniqueness, `Docs` and `docs` would be distinct
projects with confusable URLs and cookie paths, while the reserved-name check is already
case-insensitive — uniqueness and reservation would disagree about what "same name" means.
Derived names are already lowercase (`slugifyIdentifier`); only explicit `--project` input is
affected, and it gets a clear 400/CLI error. Requiring an alphanumeric final char also keeps
`scratchwork clone` from creating Windows-hostile `foo.` directories. Alternative if strict
minimality is preferred: keep the mixed-case grammar and add a `Docs`-vs-`docs` coexistence
test — not recommended.

**The one decision to confirm before cutover:** wiping the live sndbx.sh data (D1 rows + R2
objects) and republishing. No URL on the old two-segment scheme survives this change.

## 2. Data model

### Namespaces and keys (`server/core/src/site-records.ts`)

| Namespace | New key | Old key |
|---|---|---|
| `projects` | `<project>` (bare name) | `<workspace>/<project>` |
| `projects-by-owner` | `<encodeKeySegment(owner.id)>/<project>` | `<encodedOwnerId>/<workspace>/<project>` |
| `routes` | **deleted** | route path → `{workspace, project}` |

- `projectKey(workspace, project)` — **deleted**; callers pass the name directly.
- `revisionRecordKey(project, id)` → `projects/${project}/revisions/${id}.json`.
- `blobObjectKey` unchanged (`blobs/sha256/{aa}/{hash}`).
- `ownerIndexKey(owner, project)` → `${encodeKeySegment(owner.id)}/${project}`; `ownerIndexPrefix` unchanged.
- Rewrite the header prose (lines 1–8) for the two-namespace model.
- No storage/DB adapter changes: `s3-storage.ts`, `r2-storage.ts`, `dynamodb-db.ts`, `d1-db.ts` treat keys as opaque.

### Record schemas (exact target shapes, version literals bumped)

**SiteRecord v4** (was 3), `projects` at key `<project>` — `workspace` and `routePath` deleted:

```json
{ "version": 4, "project": "hello-world", "visibility": "private",
  "owner": { "id": "…", "email": "…" }, "createdAt": "…", "updatedAt": "…",
  "currentRevisionId": "…", "currentOpenPath": "/", "fileCount": 3, "totalBytes": 12345 }
```

**OwnerProjectRecord v2** (was 1): `{ "version": 2, "project": "hello-world" }`

**SiteRevisionRecord v3** (was 2): drops `workspace`; `SiteFileObjectSchema` unchanged.

**RouteRecordSchema / `RouteRecord`: deleted.**

The version bumps are what make "wipe" safe rather than hopeful: `ownerIndexPrefix` is
unchanged, so old `${owner}/${ws}/${project}` entries still match the prefix — with the bump
they fail decode **loudly** in `listProjects` instead of half-parsing. The wipe is therefore
a hard prerequisite for pointing the new server at an old store (§10).

## 3. Publish protocol

### Wire shapes

Request `POST /api/publish` — `workspace` deleted, nothing added:

```json
{ "bundle": { … }, "openPath": "/", "project": "hello-world", "visibility": "private" }
```

`project` stays optional at the protocol level: the server mints in random mode, and the CLI
omits it when derivation fails (§6). `user` mode 400s on a missing name.

Response — `workspace` and `routePath` deleted:

```json
{ "project": "x7k2mqp3ra", "visibility": "private", "openPath": "/",
  "url": "https://pages.example.com/x7k2mqp3ra/" }
```

The CLI learns the assigned name **only** from `response.project` and must always write it
back to `.scratchwork.json` — that echo is what makes random-mode republish converge.

### Server publish algorithm (`site-store.ts`, replacing the workspace resolution + create/update split)

```
name     = request.project        (charset-validated by schema when present)
existing = name != null ? get(projects, name) : null

1. UPDATE (both modes): existing != null && caller is owner
   → update with ifMatch precondition (semantics unchanged).

2. user mode:
   a. name == null                → 400 "project name is required (pass --project)"
   b. isReservedSlug(name)        → 400 `Project name is reserved: <name>`
   c. existing != null, not owner → 409 canonical taken-message
   d. create: write revision JSON, then put record { ifNoneMatch: "*" }.
      On PrimitiveDbConflict → the same 409 taken-message.

3. random mode (when case 1 did not match):
   discard the sent name; loop (max 3):
     slug = randomSlug(); if get(projects, slug) != null continue;
     write revision JSON at revisionRecordKey(slug, id);
     put record { ifNoneMatch: "*" }; on conflict continue;
   after 3 failures → 500 "Could not allocate a project name".
   Run the reserved check on the minted slug anyway (defense in depth; a 10-char
   slug of the slug alphabet can never equal a reserved name).
```

Revision JSON is written before the record claim (readers must never see a record pointing at
a missing revision), so a lost create race can orphan one revision doc under another owner's
`projects/<name>/revisions/` prefix. Accepted — revision ids are 16 random bytes and
unreferenced; do **not** add a `deleteObject` storage API for cleanup (none exists today, and
adding one is an unplanned cross-adapter change). Record the acceptance in a code comment.

### Random slug spec (`server/core/src/tokens.ts`)

Keep `randomSlug()` as-is: 10 chars over the 31-char unambiguous alphabet
`abcdefghjkmnpqrstuvwxyz23456789` (~49.5 bits; test pattern `/^[a-z2-9]{10}$/` carries over).
Update its docstring (it is now the random project-name generator). The modulo bias in
`randomAlphabetString` is negligible here; no change.

### Error contract (publish)

| Condition | Status | Message |
|---|---|---|
| No `project`, user mode | 400 | `project name is required (pass --project)` |
| Invalid identifier (incl. uppercase) | 400 | schema error (`Invalid project`) |
| Reserved name | 400 | `Project name is reserved: <name>` |
| Name taken (user mode, load-time or put race) | 409 | `Project name "<name>" is already taken on this server. Choose another with --project.` |
| Old client sending `workspace` | 400 | schema excess-property error naming `workspace` |

## 4. Server core, file by file (implementation order within the commit)

1. **`config.ts`** — delete `projectRoutingMode` / `defaultWorkspace` / `usersCanCreateWorkspaces`
   fields (23–29), the `ProjectRoutingMode` / `DefaultWorkspaceMode` types (35–42), their env
   reads (97–99), `readProjectRoutingMode` / `readDefaultWorkspace` (176–198), and `readBoolean`
   (200–207, sole caller dies). Add:

   ```ts
   /** "user": publishers choose globally-unique names (first-writer-wins).
    *  "random": the server assigns a random slug on first publish. */
   export type ProjectNamingMode = "user" | "random";
   // in ServerConfigShape:
   /** How new projects get their globally-unique name. */
   readonly projectNaming: ProjectNamingMode;
   ```

   plus `readProjectNaming(env.SCRATCHWORK_PROJECT_NAMING)`: empty/absent → `"user"`; anything
   other than `user`/`random` → `ServerConfigError` `SCRATCHWORK_PROJECT_NAMING must be user or random`.

2. **`routes.ts`** — rewrite for depth 1. Delete `routeDepth`, `safeRoutePath`, and the config
   import. Rename `routePathForRequest` → **`projectForRequest(pathname): string | null`**:
   first raw segment, `decodePathSegment`d, returned iff `isSafeProjectIdentifier` (this
   preserves the encoded-slash defense: `%2F` decodes to `/` and fails the identifier check;
   undecodable `%zz` stays raw and fails on `%`). `routeRest(pathname, project)` keeps its
   decoded-segment comparison over one segment. Rewrite module prose.

3. **`site-records.ts`** — per §2.

4. **`publish-request.ts`** — delete the `workspace` field from `PublishRequest` (26), from
   `RawPublishRequestSchema` (50), and from `normalizePublishRequest` (137). Keep
   `onExcessProperty: "error"`.

5. **`site-store.ts`** — the big rewrite. Single-name signatures on `SiteStoreShape`
   (`loadProject(project)`, `unpublish`, `deleteProject`, `bundle`); `publishProject`
   implements §3; `writeNewProject` becomes the single `ifNoneMatch:"*"` put;
   `loadPublishedSiteByRoute` merges into `loadPublishedSite(project)`. **Guard rider:**
   `loadProject` returns null (→ 404) when `!isSafeProjectIdentifier(project)` — today
   `safeRoutePath` inside `loadPublishedSiteByRoute` is the only thing turning garbage route
   input into 404 instead of a `safeDbKey` 500 (`db.ts` rejects `""`/`.`/`..` keys with an
   error that maps to 500); this preserves that guard in one place for every caller. Delete
   `defaultWorkspace()`, `requireUsableWorkspace()`, `workspaceExists()`,
   `routePathForProject()`, `emailDomain()`, `loadRouteRecord` / `putRouteRecord`, the
   route-claim rollback, the `workspaceFromEmail` import, and the second
   `requireProjectIdentifier` call (drop its label param). `PublishResult` loses `workspace`
   and `routePath`.

6. **`auth.ts` + `cookies.ts`** — payload collapse per §1 (rename `projectKey` → `project`,
   drop `routePath`; `issueProjectAccessToken(project, user, use)` /
   `verifyProjectAccessToken(token, project, use)`). No `SESSION_VERSION` bump. Cookies:
   `Path=/${project}`; cookie name = `prefix + project` verbatim — delete the `/`→`_`
   flattening and its collision caveat (the identifier charset is entirely cookie-name-token
   legal, and names are globally unique, so names are collision-free by construction).

7. **`app.ts`** —
   - `projectApiPath` regex → `/api/projects/:project(/:action)` (one segment); after
     `decodeURIComponent`, return null unless `isSafeProjectIdentifier(project)` — do not rely
     on the store 404ing weird keys. Dispatch and the four handlers take `project` only.
   - Delete the `/api/resolve` route + `resolveProjectPath` handler.
   - `projectSummary` → `{ project, visibility, url, owner, createdAt, updatedAt,
     currentOpenPath, fileCount, totalBytes }` with `url = ${contentBase}/${encodeURIComponent(project)}/`.
   - **`listProjects` handler (app.ts:178) must pass `contentBase`** — today it calls
     `projectSummary(project)` bare, so list items have `url: undefined`; every draft that
     drops the CLI fallback missed this. Fix it and add a test.
   - `loadSiteForPath` uses `projectForRequest`; no config dependency.
   - Every `site.record.routePath` consumer switches to `site.record.project`: canonical 308
     → `/${project}/`, `pathPrefix` → `/${project}`, `safeContentReturnTo`,
     `projectAccessRedirect`, handoff issue/redeem. This is the redirect-correctness linchpin
     — a missed call site yields redirects to `/undefined/`.
   - `/auth/project` keeps its `route` query param name, now carrying the bare project name;
     validate it with `isSafeProjectIdentifier` (empty string currently slips past the
     `== null` check and would 500 in the DB key guard).

8. **`access.ts`** — delete the `workspaceFromEmail` re-export (47); extend
   `RESERVED_ROUTE_SLUGS` per §1; update the `isReservedSlug` docstring ("guards project names").

9. **`index.ts`** — delete exports of `DefaultWorkspaceMode`, `ProjectRoutingMode`,
   `workspaceFromEmail`, `projectKey`, `RouteRecord`, `routeDepth`; export `ProjectNamingMode`.

## 5. Server config plumbing and deploy targets

Env-var mapping:

| Old | New |
|---|---|
| `SCRATCHWORK_PROJECT_ROUTING_MODE` | **deleted** |
| `SCRATCHWORK_DEFAULT_WORKSPACE` | **deleted** |
| `SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES` | **deleted** |
| — | **`SCRATCHWORK_PROJECT_NAMING`** = `user` (default) \| `random` |

- `server/scripts/server-settings.ts` — replace the three fields (21–23) with
  `readonly projectNaming?: "user" | "random";`; in `serverConfigEnv` replace the three
  mappings (69–71) with `if (config.projectNaming != null) env.SCRATCHWORK_PROJECT_NAMING = config.projectNaming;`.
- `server/deploy-cloudflare/src/deploy.ts:224–226` — replace the three `copyEnv` lines with
  one for `SCRATCHWORK_PROJECT_NAMING`. **This allowlist is the #1 silent-failure trap**: a
  missed entry means the Worker runs default `user` mode regardless of config.
- `server/deploy-local/src/run.ts:110–112` — replace the three `set(...)` lines with
  `set("SCRATCHWORK_PROJECT_NAMING", server.projectNaming)` (keep env-wins precedence).
- `server/deploy-aws/**` — no change (generic `SCRATCHWORK_*` prefix pass-through; the next
  deploy rewrites the Lambda env and drops the stale vars).
- Deploy projects: `deploy/sndbx.sh/server-config.ts:11–12` → `projectNaming: "user"`;
  `deploy/local-dev/local.ts:7` → delete the `projectRoutingMode` line (default applies);
  `deploy/generic-aws/` → no config edit; add a commented
  `# SCRATCHWORK_PROJECT_NAMING=user  # or "random"` line to its `.env.example`.
- Docs: `server/deploy-local/README.md:26` → `SCRATCHWORK_PROJECT_NAMING=user|random`;
  add the var to `server/README.md`'s env section (it documents no workspace vars today).

## 6. CLI

### Final flag surface

| Command | Synopsis | Change |
|---|---|---|
| `publish` | `scratchwork publish [path] [--server url] [--project name] [--visibility scope]` | drop `--workspace` |
| `unpublish` / `delete` / `info` | `… [path-or-url] [--server url] [--project name]` | drop `--workspace` |
| `clone`, `stream`, `projects`, `me`, `login`, `dev`, `example`, `template`, `version` | unchanged | — |

### Default-name derivation (exact rules, all client-side)

Precedence, highest first:

1. **`--project`** — validated against the (tightened) identifier grammar; on failure:
   `scratchwork publish: invalid project <name> (lowercase letters, digits, ".", "_", "-")`.
   Never slugified: explicit input is respected or rejected.
2. **`.scratchwork.json` `project`** — same validation; only from the publish root's own
   config (existing behavior).
3. **Derived default** — directory target: `slugifyIdentifier(basename(dir), "")`;
   single-file target (**new**; replaces the current hard error at `publish.ts:314–317`):
   `slugifyIdentifier(stem(basename(file)), "")` where `stem` strips the final extension only
   (the substring after the last `.`, iff that dot is not at index 0 and a stem remains).
   Examples: `notes.md → notes`, `report.html → report`, `data.tar.gz → data.tar`,
   `.env → env`, `index.html → index` (predictable beats clever). Implement `stem` as a
   private helper in `publish.ts` — do **not** reuse `openPathForFile`
   (`cli/src/dev/target.ts`), which strips only `.html`/`.md` because it builds a servable
   route, not a name. Have `resolveProjectName` take the already-resolved target from
   `runPublish` instead of re-statting.
4. **Derivation failure** (name slugifies to empty — e.g. `日本語/`, `!!!.md`): send **no**
   `project` field. A random-mode server mints; a user-mode server returns the 400, which the
   CLI maps to `scratchwork publish: cannot derive a project name from "<basename>"; use
   --project`. Never pass a non-empty fallback (the current `"project"` literal would become
   a global-namespace footgun: two unrelated non-ASCII directories from the same owner would
   silently republish over each other).

### `.scratchwork.json` (final schema + legacy posture)

```json
{ "server": "https://app.sndbx.sh", "project": "hello-world",
  "visibility": "private", "url": "https://pages.sndbx.sh/hello-world/",
  "updatedAt": "2026-07-04T00:00:00.000Z" }
```

`workspace` and `routePath` removed. Legacy files: silently ignored keys —
`decodeProjectConfig` already drops unrecognized fields, and deleting the two copy lines
makes them unrecognized. No warning machinery; the file is rewritten in the new schema on the
next successful publish. Note: the example projects' `.scratchwork.json` files are **not in
git** (`.gitignore` excludes them by policy) — they are stale local publish state, regenerated
by republishing. No fixture edits or `git rm` exist to be done here.

### File-by-file

- `cli/src/types.ts` — delete `PublishConfig.workspace` (28) and `ProjectRefConfig.workspace` (47).
- `cli/src/index.ts` — delete both `workspace:` textOptions (81, 90); `--project` help text →
  `"Project name for the published URL. Default: saved config, the directory name, or the
  file name without its extension. Servers in random-naming mode assign a name on first
  publish."`; fix the delete-command description (134): it still says "project pointer and
  route".
- `cli/src/api.ts` — `ResolvedProjectRef` → `{ server, project }`; `projectApiUrl` →
  `` `/api/projects/${encodeURIComponent(ref.project)}${suffix}` ``; delete
  `resolveProjectByPath` (100–125) and its now-unused imports.
- `cli/src/project-config.ts` — drop `workspace`/`routePath` from `ProjectConfigFile` and
  `decodeProjectConfig`; header prose → `--server/--project`. `resolveProjectRef`: explicit
  `--project` short-circuits; URL branch computes
  `project = nonEmpty(input.project) ?? projectFromPathname(url.pathname)` where
  `projectFromPathname` decodes the first path segment (guarded) and requires
  `isSafeProjectIdentifier`, failing with `scratchwork <cmd>: invalid project URL`; local
  branch falls back to `config.project`; missing → `scratchwork <cmd>: project is required`.
- `cli/src/commands/publish.ts` — `PublishResponse` → `{ project, visibility, openPath, url }`;
  drop workspace resolution and body field; `resolveProjectName` per the rules above;
  `writeMetadata` writes `{ server, project: response.project, visibility, url, updatedAt }`;
  `decodePublishResponse` drops the workspace/routePath checks; `printResult` prints
  `project ${response.project}` and, when the sent name differs from `response.project`,
  appends `` `note    server assigned project name "${response.project}"` `` — this is how
  random-mode users learn their slug (and how a typo'd `--project` on a random server becomes
  visible instead of silent).
- `cli/src/commands/projects.ts` — `ApiProject` → `{ project, visibility, url?, updatedAt }`;
  listing line → `` `${project.project}\t${project.visibility}\t${project.url ?? `/${project.project}/`}` ``
  (keep the local fallback; it is one expression and risk-free); `Deleted ${ref.project}`;
  `Cloned ${ref.project} …`; fix the `runDelete` docstring (93): "pointer and route".
  **`runClone` additionally writes `{ server, project }` as `.scratchwork.json` into the
  destination** — publish bundles exclude the root config, so a clone otherwise carries no
  identity, and republish identity would ride on the (renamable) directory name; in random
  mode a renamed clone would silently fork a new slug project. One touchpoint closes that hole.
- `cli/src/help.ts` — drop `--workspace` from examples (79, 109, 117, 124); notes → "server/
  project" (74, 106); URLs single-segment (108–109, 116–117, 123–124, 130); fix the
  delete-command note (121): "the route is removed from the server index" is stale; add one
  publish note: "On servers that assign random project names, the first publish returns the
  assigned name; it is saved to .scratchwork.json so republishes update the same project."
- No changes: `cli/src/auth.ts`, `browser.ts`, `errors.ts`, `renderer/`, `dev/**`,
  `commands/{dev,login,template,example}.ts` (all verified workspace-free; `stream` is
  transitively fixed via `resolveProjectRef`).

## 7. shared/ and renderer

- `shared/src/site/identifiers.ts` — delete `workspaceFromEmail` (24–28; sequenced **after**
  server/core stops importing it); tighten `isSafeProjectIdentifier` per D-grammar; rewrite
  the header and docstrings to say "project identifier". `slugifyIdentifier` logic unchanged.
- `shared/src/site/serve.ts:263` — comment example → single-segment prefix.
- Everything else in `shared/` and all of `renderer/` — no changes (verified). Optionally
  refresh the cookie-path comment in `renderer/src/main.js:115–116`.

## 8. Deletion inventory and do-not-touch list

Deleted outright, no successor: `workspaceFromEmail`; `ProjectRoutingMode`,
`DefaultWorkspaceMode`, `readProjectRoutingMode`, `readDefaultWorkspace`, `readBoolean`;
`routeDepth`, `safeRoutePath`; `ROUTES_NAMESPACE`, `RouteRecordSchema`, `RouteRecord`,
`projectKey`, `loadRouteRecord`, `putRouteRecord`, the route-claim rollback;
`defaultWorkspace()`, `requireUsableWorkspace()`, `workspaceExists()`,
`routePathForProject()`, `emailDomain()`, `loadPublishedSiteByRoute`; the `/api/resolve`
handler and `resolveProjectByPath`; the `workspace` field in every schema/type/response/config
file; the `routePath` field everywhere; the three env vars; both `--workspace` flags.

**Do NOT touch** (bulk-grep hazards — never bulk-replace "workspace"): root `package.json`
`"workspaces"` (Bun monorepo config), `"workspace:*"` deps in `deploy/*/package.json`,
`bun.lock` / `cli/bun.lock` / `renderer/bun.lock` `"workspaces"` keys,
`server/package.json:6`'s description ("…server workspace commands" — npm-workspace sense),
heading-anchor "slug" code in `renderer/src/`, `shared/src/publish/bundle.ts`,
`shared/src/site/routing.ts`, `cli/src/dev/**`, `server/deploy-aws/src/**`,
`d1-db.ts`/`dynamodb-db.ts`/`s3-storage.ts`/`r2-storage.ts`, `server/scripts/env.ts`/`proc.ts`,
the uncommitted `notes/spec.md` homepage draft, and `notes/remove-workspaces-codex.md`.

## 9. Docs

- `README.md:28` → `scratchwork publish [path]` (+ a line showing `--project myproject`);
  `README.md:85` saved-fields list → "`server`, `project`, `visibility`, and the latest URL".
- `notes/spec.md` (edit the committed text; see the preamble about the homepage draft):
  - **Concepts** (7): delete the workspace paragraph; add: a project has a globally unique
    name per server; the server either lets publishers choose names (`projectNaming: "user"`,
    first-writer-wins) or assigns a random slug on first publish (`"random"`). Note the
    lowercase name grammar.
  - **Project Config** (31–45): new JSON example per §6; `server` + `project` are the portable
    identity fields; `workspace`/`routePath` gone.
  - **Server Config** (84–99): replace the three knobs with `projectNaming: "user"` plus a
    comment covering both modes and the reserved names.
  - **CLI interface** (229–270): new default-name rule (directory name / file name minus
    extension — supersedes "the name of the project must be specified" for files); drop every
    `--workspace text`; project references become "server + project flags, project config, or
    a URL like `example.com/myproject/`"; note random-mode assignment on first publish.
  - **Security** (292): cookie scope `Path=/<project>`; single-segment clean URLs; reserved
    prefixes rejected as project names.
- `docs/index.md`: no edit now (publishing section is a placeholder); future text must
  describe single-segment URLs and the two naming modes.

## 10. Execution sequence and cutover

Compile-dependency facts (verified): CLI imports only `shared/`, never `server/core`; deploy
scripts own their config type in `server/scripts/server-settings.ts`; CLI tests run against a
fake in-process server. So server and CLI can land in separate green commits. Known
mid-sequence state: between steps 2 and 5 the real CLI is runtime-incompatible with a
locally-run new server — tests stay green; don't manually publish in between. Commit
stepwise, **deploy atomically** (the protocol breaks both directions).

1. **Step 0 — local-state hygiene.** `deploy/sndbx.sh/.scratchwork-local-data/` and the
   `examples/*/.scratchwork.json` files are untracked and already gitignored (verified —
   earlier drafts' `git rm` steps were a false premise). Delete or ignore them locally;
   they regenerate on republish. No git operations exist to be done.
2. **server/core (src + tests, one commit)** — §4 order, §11 tests.
3. **shared/** — §7 (now import-free).
4. **Deploy plumbing + deploy-project configs (one commit** — the type change and its
   consumers move together**)** — §5.
5. **CLI (src + tests, one commit)** — §6, §11.
6. **Docs** — §9.
7. **Verification + cutover.** Local (`deploy/local-dev`): publish a directory (default
   name), a single `.md` file (extension-strip), a private project (cookie name/path, handoff,
   308 canonicalization, cross-project subresource isolation), a reserved name → 400, an
   uppercase name → 400; flip to `projectNaming: "random"` and verify mint + republish-by-slug
   + the assigned-name note. Live sndbx.sh (after the §1 confirmation): wipe D1 rows and R2
   objects (`wrangler d1 execute` DELETE + R2 purge) — **the wipe is a hard prerequisite**
   (owner-index decode hazard, §2); redeploy (rewrites Worker vars, dropping the three stale
   env vars); republish the example projects.

## 11. Tests

**`server/core/test/helpers.ts`** — config fixture: the three fields → `projectNaming: "user"`.

**`server/core/test/app.test.ts`**
- Mechanical: drop `workspace` from every POST body and response assertion; paths
  `/demo/site/` → `/site/`; revision prefix `projects/site/revisions/`; `route=secret`;
  cookie `__Secure-scratchwork_access_secret`, `Path=/secret`; encoded-slash case `/si%2Fte` → 404.
- Delete: userDomain-mode test (193–215), `usersCanCreateWorkspaces` test (217–245),
  `/api/resolve` test (155–178), username-shadow half of the reserved test (143–152).
- Rework: reserved test posts `project: "api" | "auth" | "health" | "robots.txt"` → 400;
  random-workspace test (180–191) → `projectNaming: "random"`: `published.project` matches
  `/^[a-z2-9]{10}$/`, `url` ends `/${published.project}/`.
- New: (a) cross-user collision — B publishing A's name → 409 with the exact canonical
  message; A's republish still 200; (b) create race → same 409, not the raw DB message;
  (c) random-mode republish — resending the returned slug updates in place; (d) random-mode
  unknown/unowned name → fresh slug ≠ sent name; (e) user-mode missing `project` → 400;
  (f) body containing `workspace: "demo"` → 400 (locks the hard break); (g) uppercase name →
  400; (h) `/api/projects` list items carry `url`; (i) `GET /auth/project?route=` with
  empty/`..`/`%2E%2E` → 4xx, never 500 (same for `DELETE /api/projects/%2E%2E`).

**`auth.test.ts`** — defaults assert `projectNaming === "user"`; env tests →
`SCRATCHWORK_PROJECT_NAMING=random` accepted, `=bogus` rejected with the exact error string.
Verify old-format access cookies fail decode into a redirect, not a 500.

**`publish-request.test.ts`** — drop `workspace` from the happy path; `"Invalid workspace"`
case → `project: "../bad"` and `project: "Docs"` → `Invalid project`; excess-property case.

**`site-store.test.ts`** — `record()` fixture drops `workspace`/`routePath`, version 4;
delete the route-rollback test (mechanism gone), replace with the `ifNoneMatch`-conflict
test; `routePathForRequest` cases → `projectForRequest` single-segment (keep `%2F` rejection
and percent-decoding); `routeRest` fixtures single-segment; garbage input to `loadProject`
(`""`, `".."`) returns null.

**`db.test.ts`** — no change (keep slash-containing keys; owner-index keys still use `/`).

**Deploy packages** — no required changes; optionally add `SCRATCHWORK_PROJECT_NAMING` to the
`worker.test.ts` fixture. `handler.test.ts`, `env.test.ts`: no change.

**`cli/test/e2e.test.js`** (~16 workspace references; missed by two of three drafts):
fake publish responses drop `workspace`/`routePath` and use single-segment `url` (661–666,
919); fake routes `/api/projects/founder/site*` → `/api/projects/site*` (751–756);
`publishBody.workspace` assertions deleted (715, 944); invocations drop `--workspace founder`
(770–772) with output `"Deleted site"` etc.; `.scratchwork.json` fixtures drop `workspace`
(734, 867, 934, 973); `/api/resolve` fakes deleted (748, 798–799) and the `seen` assertion
(779) flips to proving no resolve call is made. New CLI tests: file-stem naming table
(`notes.md → notes`, `report.html → report`, `data.tar.gz → data.tar`); `--project` wins;
directory default; underivable name → no `project` sent + friendly 400 mapping; legacy config
with `workspace` key silently ignored; clone writes `{ server, project }`; assigned-name note
printed when sent ≠ returned. (`help.test.js` asserts only `"Usage:"` — safe; `auth.test.js`,
`components.test.js` clean.)

## 12. Risks, ranked

1. **Cloudflare env allowlist (silent).** `SCRATCHWORK_PROJECT_NAMING` missing from `copyEnv`
   → Worker silently runs default mode. Step 4 bundles the type change with all consumers.
2. **`pathPrefix`/redirect wiring.** Every former `record.routePath` consumer must switch to
   `record.project`; a miss yields `/undefined/` redirects. The private-content tests are the
   guard — keep every one.
3. **Encoded-slash fabrication.** Single-segment parsing must decode-then-validate on both
   server and CLI. Keep the `%2F` tests on both sides.
4. **Un-wiped stores.** Old owner-index rows match the unchanged prefix and fail v2 decode —
   `listProjects` errors until the wipe. Deliberate (loud beats silent); the runbook leads
   with the wipe.
5. **Garbage-input 500s.** The `safeRoutePath` deletion removes today's only garbage→404
   guard; the `loadProject` validation rider (§4.5) and `projectApiPath`/`/auth/project`
   checks (§4.7) are load-bearing, not cosmetic.
6. **Reserved names now hit CLI defaults.** A directory literally named `api` derives a
   reserved name → server 400; the message should hint `--project`.
7. **Random-mode strays.** Deleting `.scratchwork.json` (or renaming a clone before §6's fix)
   and republishing mints a duplicate project under a new slug. Accepted; `scratchwork
   projects` lists strays for cleanup; the clone config-write closes the main path.
8. **Bulk-grep collateral.** See the do-not-touch list (§8).
9. **Spec collision.** §9's spec rewrite starts from the committed text; the uncommitted
   homepage draft must be rebased over it, not merged blind.
