# Final plan: remove workspaces from Scratchwork

Merged from `notes/remove-workspaces-claude.md` and `notes/remove-workspaces-codex.md` with
all open disagreements decided (see §1). Projects are currently namespaced as
`workspace/project`. This plan removes the workspace concept entirely: a project is
identified by a single, server-globally-unique **project name**. The public URL is
`https://<contentDomain>/<project>/…`, the DB key is the project name, the cookie path is
`/<project>`, and the API path segment is the project name. The redundant route abstraction
(`routePath`, route index) is deleted along with workspaces.

All spec references are to the **committed** `notes/spec.md`. The working tree carries an
uncommitted homepage-feature draft in that file; the spec edits in §9 apply on top of the
committed text, and the homepage draft must be rebased over them by its author — do not merge
blind. Any repo-wide "workspace" grep will also hit the three plan files in `notes/`.

## 1. Design decisions (normative)

| Concern | Decision |
|---|---|
| Project identity | One globally-unique name per server, exact-match. Grammar tightened to lowercase: `/^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/` — lowercase letters and digits, with `.`, `_`, `-` allowed in interior positions, first/last char alphanumeric, max 128 chars. Deleting a project releases its name. |
| Naming mode | New config `usersCanSetProjectNames: boolean`, env `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`, default `true`, strict boolean parsing (keep `readBoolean`). Replaces `projectRoutingMode`, `defaultWorkspace`, and `usersCanCreateWorkspaces` outright. `userDomain` routing is deleted with no successor. |
| CLI default name | `--project` > saved `.scratchwork.json` in the publish root > derived. Directory target → directory basename, slugified. Single-file target → file basename minus its **final** extension, slugified (`report.v2.md` → `report.v2`). A file target's publish root remains its containing directory (sibling assets/renderers stay in the bundle), so the file-stem default applies only when that directory has no saved project. The CLI always sends a name when it can derive one; it never needs to know the server's naming mode. |
| Random-mode semantics (`usersCanSetProjectNames: false`) | A client-sent name that matches a project the caller owns → update (this is republish; the CLI echoes the slug saved in `.scratchwork.json`). A sent name that exists but is **owned by someone else → 409** with the canonical taken-message, same as user mode — never silently fork. A sent name that does not exist is ignored as a creation name; the server mints `randomSlug()`. No new protocol field; the CLI prints a note when the returned name differs from the sent one and always saves `response.project`. |
| Collisions | 409 with one canonical message: `Project name "<name>" is already taken on this server. Choose another with --project.` Used for the load-time check, the not-owner case in both modes, and the create race (`PrimitiveDbConflict` must be caught and mapped — never surface the raw `Record already exists: <key>` DB message). The existence leak to authenticated users is accepted: names are public URL segments. |
| Uniqueness claim | The `ifNoneMatch: "*"` put of the project record (key = bare name) is the **single** uniqueness claim. The routes DB namespace, `RouteRecord`, and the two-phase claim/rollback in `writeNewProject` are deleted. One write, no rollback dance, one fewer DB hop per content request. |
| `routePath` | Deleted everywhere (DB records, API responses, `.scratchwork.json`, spec). It always equals the project name; a field that is always derivable is a field that can silently disagree. |
| `/api/resolve` | **Kept**, project-only. It centralizes validation, authorization, and URL→project resolution for commands given a published URL, and a future homepage URL will need host-aware resolution the CLI cannot do locally (the CLI currently sends only a path). The response becomes a project-only summary. |
| Access tokens | `ProjectAccessPayloadSchema` carries three things: `project` (identity, renamed from `projectKey`), `scope` (the cookie's path scope, normally `/<project>` — kept distinct from identity so a future homepage alias can scope a token to `/` without a format change), and an explicit payload `version` (starts at 1, independent of `SESSION_VERSION`, so future format changes can deliberately invalidate access cookies without touching OAuth sessions or CLI bearer tokens). Old cookies fail decode on the renamed field and re-run the handoff (`app.ts:404` and `app.ts:430` already wrap verification in `orElseSucceed(() => null)` → redirect, not 500 — verify during implementation). No `SESSION_VERSION` bump: session tokens don't change shape. |
| Reserved names | Extend `RESERVED_ROUTE_SLUGS` per §1a below. Reservation stays server-side in `access.ts` — it is route policy, not identifier grammar, and the CLI must not hardcode it. |
| Legacy `.scratchwork.json` | **Explicit error, not silent ignore.** If the decoded file contains a `workspace` or `routePath` key, publish (and any command reading the config) fails naming the offending key(s): `scratchwork <cmd>: .scratchwork.json contains legacy field(s) "workspace"/"routePath" from the workspace era; delete the file or remove those fields, then republish (pass --project to keep a specific name).` The file is rewritten in the new schema on the next successful publish. |
| Old-client compatibility | **Hard break.** `RawPublishRequestSchema` keeps `onExcessProperty: "error"`, so an old CLI sending `workspace` gets a 400 naming the field; old `/api/projects/:ws/:proj` paths 404. Pre-release, single-team tool; no tolerance window. |
| Existing data | **Wipe, don't migrate. No backwards compatibility.** Live sndbx.sh D1 rows and R2 objects are deleted and the example projects republished. Record version literals are bumped so any stragglers fail loudly. No v2 namespaces, no migration script, no maintenance-window dual-running. |
| Bundle format | `PUBLISH_BUNDLE_VERSION` unchanged — the bundle never carried identity; the protocol break is enforced by the request schema. |
| `randomSlug()` | Keeps its name; docstring updated (it is now the random project-name generator). 10 chars over the 31-char unambiguous alphabet `abcdefghjkmnpqrstuvwxyz23456789` (~49.5 bits; test pattern `/^[a-z2-9]{10}$/` carries over). The modulo bias in `randomAlphabetString` is negligible; no change. |
| AWS deploy env | No change. `deploy-aws` forwards `SCRATCHWORK_*` generically; the next deploy rewrites the Lambda env and the new server never reads the retired vars, so any lingering shell value is inert. |

### 1a. Reserved names (full list)

`RESERVED_ROUTE_SLUGS` becomes (grouped for readability; stored flat):

- **Existing route policy:** `api`, `auth`, `health`, `favicon.ico`, `favicon.svg`
- **Host-wide root files** (under single-segment routing a project named `robots.txt` would
  control crawl policy for the whole content host; names are permanent once claimed):
  `robots.txt`, `sitemap.xml`, `ads.txt`, `app-ads.txt`, `security.txt`
- **Future namespace prefixes** (reserved now so a later "org/hub/domain space" concept can
  use them; not built in this change): `gh`, `g`
- **Auth/identity providers** (same future-namespace rationale): `github`, `gitlab`, `gl`,
  `bitbucket`, `bb`, `google`, `microsoft`, `ms`, `apple`, `okta`, `auth0`, `x`, `twitter`,
  `facebook`, `fb`, `linkedin`, `li`, `slack`, `discord`

**Underscore prefix:** the tightened grammar requires an alphanumeric first character, so a
bare `_` and every `_`-prefixed name are unclaimable by construction — the entire `_*`
namespace is reserved for future internal use without a list entry. Record this in a comment
next to `RESERVED_ROUTE_SLUGS` and in the spec. (`.well-known` likewise needs no entry —
a leading `.` is not a valid identifier.)

The reserved check stays case-insensitive; with the lowercase grammar, uniqueness and
reservation now agree about what "same name" means. The requirement that the final char be
alphanumeric also keeps `scratchwork clone` from creating Windows-hostile `foo.` directories.

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
- Rewrite the header prose for the two-namespace model.
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
omits it when derivation fails (§6). User-set-names mode 400s on a missing name.

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

2. TAKEN (both modes): existing != null && caller is NOT owner
   → 409 canonical taken-message. (Applies in random mode too — a stale or
     copied .scratchwork.json surfaces as an explicit error, never a silent fork.)

3. usersCanSetProjectNames = true (create):
   a. name == null                → 400 "project name is required (pass --project)"
   b. isReservedSlug(name)        → 400 `Project name is reserved: <name>`
   c. create: write revision JSON, then put record { ifNoneMatch: "*" }.
      On PrimitiveDbConflict → the same 409 taken-message.

4. usersCanSetProjectNames = false (create; sent name, if any, did not exist):
   discard the sent name; loop (max 3):
     slug = randomSlug(); if get(projects, slug) != null continue;
     write revision JSON at revisionRecordKey(slug, id);
     put record { ifNoneMatch: "*" }; on conflict continue (rebuild the complete
     create attempt for the fresh candidate — never attach to an existing project);
   after 3 failures → 500 "Could not allocate a project name".
   Retry only the project-key collision, not unrelated storage/DB failures.
   Run the reserved check on the minted slug anyway (defense in depth; a 10-char
   slug of the slug alphabet can never equal a reserved name).
```

Revision JSON is written before the record claim (readers must never see a record pointing at
a missing revision), so a lost create race can orphan one revision doc under another owner's
`projects/<name>/revisions/` prefix. Accepted — revision ids are 16 random bytes and
unreferenced; do **not** add a `deleteObject` storage API for cleanup (none exists today, and
adding one is an unplanned cross-adapter change). Record the acceptance in a code comment.

If a saved random project was deleted server-side, the next publish falls through to case 4
and creates a fresh random project; the CLI saves the new name. Publishing remains a
name-based upsert — no create/update intent field is added to the protocol; if the requested
name already belongs to the caller, publishing updates it even from a different local
directory, and callers use `--project` when an inferred basename would collide with one of
their own projects.

### Error contract (publish)

| Condition | Status | Message |
|---|---|---|
| No `project`, user-names mode | 400 | `project name is required (pass --project)` |
| Invalid identifier (incl. uppercase) | 400 | schema error (`Invalid project`) |
| Reserved name | 400 | `Project name is reserved: <name>` |
| Name taken (either mode; load-time, not-owner, or put race) | 409 | `Project name "<name>" is already taken on this server. Choose another with --project.` |
| Old client sending `workspace` | 400 | schema excess-property error naming `workspace` |

## 4. Server core, file by file (implementation order within the commit)

1. **`config.ts`** — delete `projectRoutingMode` / `defaultWorkspace` / `usersCanCreateWorkspaces`
   fields, the `ProjectRoutingMode` / `DefaultWorkspaceMode` types, their env reads, and
   `readProjectRoutingMode` / `readDefaultWorkspace`. **Keep `readBoolean`** — it now parses
   the new var. Add:

   ```ts
   // in ServerConfigShape:
   /** true: publishers choose globally-unique names (first-writer-wins).
    *  false: the server assigns a random slug on first publish. */
   readonly usersCanSetProjectNames: boolean;
   ```

   read from `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`: empty/absent → `true`; otherwise the
   same strict boolean parsing used today, with `ServerConfigError`
   `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES must be true or false` on anything else.

2. **`routes.ts`** — rewrite for depth 1. Delete `routeDepth`, `safeRoutePath`, and the config
   import. Rename `routePathForRequest` → **`projectForRequest(pathname): string | null`**:
   first raw segment, `decodePathSegment`d, returned iff `isSafeProjectIdentifier` (this
   preserves the encoded-slash defense: `%2F` decodes to `/` and fails the identifier check;
   undecodable `%zz` stays raw and fails on `%`). `routeRest(pathname, project)` keeps its
   decoded-segment comparison over one segment. Keep the canonical trailing-slash redirect
   logic. Rewrite module prose.

3. **`site-records.ts`** — per §2.

4. **`publish-request.ts`** — delete the `workspace` field from `PublishRequest`, from
   `RawPublishRequestSchema`, and from `normalizePublishRequest`. Keep `project` optional at
   decode time (random-mode creation can omit it); enforce require-or-assign in the store.
   Keep `onExcessProperty: "error"`.

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
   and `routePath`. Preserve visibility defaults, owner-only writes, current-revision
   flipping, bundle export, listing pagination, and content-addressed blobs unchanged apart
   from their project-only keys.

6. **`auth.ts` + `cookies.ts`** — payload per §1: `ProjectAccessPayloadSchema` =
   `{ version: 1, project, scope, use, … }` where `scope` is the access-path scope (normally
   `/${project}`) kept distinct from identity, and `version` is a new
   `PROJECT_ACCESS_VERSION = 1` literal independent of `SESSION_VERSION`.
   `issueProjectAccessToken(project, user, use)` computes `scope = "/" + project` today;
   `verifyProjectAccessToken(token, project, use)` checks identity, use, and version. No
   `SESSION_VERSION` bump. Cookies: `Path=` comes from the token's scope; cookie name =
   `prefix + project` verbatim — delete the `/`→`_` flattening and its collision caveat (the
   identifier charset is entirely cookie-name-token legal, and names are globally unique, so
   names are collision-free by construction).

7. **`app.ts`** —
   - `projectApiPath` regex → `/api/projects/:project(/:action)` (one segment); after
     `decodeURIComponent`, return null unless `isSafeProjectIdentifier(project)` — do not rely
     on the store 404ing weird keys. Dispatch and the four handlers take `project` only.
   - **Keep `/api/resolve`** and `resolveProjectPath`, project-only: parse the first path
     segment of the supplied path with `projectForRequest`, load, authorize, and return the
     new `projectSummary` shape. (A future homepage URL needs a separate host-aware contract;
     out of scope.)
   - `projectSummary` → `{ project, visibility, url, owner, createdAt, updatedAt,
     currentOpenPath, fileCount, totalBytes }` with `url = ${contentBase}/${encodeURIComponent(project)}/`.
   - **`listProjects` handler (app.ts:178) must pass `contentBase`** — today it calls
     `projectSummary(project)` bare, so list items have `url: undefined`. Fix it and add a test.
   - `loadSiteForPath` uses `projectForRequest`; no config dependency.
   - Every `site.record.routePath` consumer switches to `site.record.project`: canonical 308
     → `/${project}/`, `pathPrefix` → `/${project}`, `safeContentReturnTo`,
     `projectAccessRedirect`, handoff issue/redeem, referer guard. This is the
     redirect-correctness linchpin — a missed call site yields redirects to `/undefined/`.
   - `/auth/project` keeps its `route` query param name, now carrying the bare project name;
     validate it with `isSafeProjectIdentifier` (empty string currently slips past the
     `== null` check and would 500 in the DB key guard).

8. **`access.ts`** — delete the `workspaceFromEmail` re-export; extend
   `RESERVED_ROUTE_SLUGS` per §1a with the underscore-prefix comment; update the
   `isReservedSlug` docstring ("guards project names"). Visibility and ownership rules
   unchanged.

9. **`index.ts`** — delete exports of `DefaultWorkspaceMode`, `ProjectRoutingMode`,
   `workspaceFromEmail`, `projectKey`, `RouteRecord`, `routeDepth`; the new config field is
   part of `ServerConfigShape` (no new type export needed for a boolean).

## 5. Server config plumbing and deploy targets

Env-var mapping:

| Old | New |
|---|---|
| `SCRATCHWORK_PROJECT_ROUTING_MODE` | **deleted** |
| `SCRATCHWORK_DEFAULT_WORKSPACE` | **deleted** |
| `SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES` | **deleted** |
| — | **`SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`** = `true` (default) \| `false` |

- `server/scripts/server-settings.ts` — replace the three fields with
  `readonly usersCanSetProjectNames?: boolean;`; in `serverConfigEnv` replace the three
  mappings with `if (config.usersCanSetProjectNames != null) env.SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES = String(config.usersCanSetProjectNames);`.
- `server/deploy-cloudflare/src/deploy.ts` — replace the three `copyEnv` lines with one for
  `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`. **This allowlist is the #1 silent-failure trap**:
  a missed entry means the Worker silently runs the default regardless of config.
- `server/deploy-local/src/run.ts` — replace the three `set(...)` lines with
  `set("SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES", …)` (keep env-wins precedence).
- `server/deploy-aws/**` — no change (generic `SCRATCHWORK_*` prefix pass-through; the next
  deploy rewrites the Lambda env and drops the stale vars; the new server never reads them).
- Deploy projects: `deploy/sndbx.sh/server-config.ts` → `usersCanSetProjectNames: true`
  (preserves friendly-name behavior; flipping this public-login deployment to random names is
  a separate operator decision, now a one-line change); `deploy/local-dev/local.ts` →
  `usersCanSetProjectNames: true` explicitly, for predictable local URLs;
  `deploy/generic-aws/` → no config edit; add a commented
  `# SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES=true  # or false for server-assigned names`
  line to its `.env.example`.
- Docs: `server/deploy-local/README.md` → the new var; add it to `server/README.md`'s env
  section (it documents no workspace vars today), including the rule that a returned random
  name is what the CLI uses for updates.
- `server/package.json` description still says "server workspace commands" in the
  npm-workspace sense — leave it (see do-not-touch, §8); but if any prose there refers to
  publishing workspaces, fix that occurrence only.

## 6. CLI

### Final flag surface

| Command | Synopsis | Change |
|---|---|---|
| `publish` | `scratchwork publish [path] [--server url] [--project name] [--visibility scope]` | drop `--workspace` |
| `unpublish` / `delete` / `info` | `… [path-or-url] [--server url] [--project name]` | drop `--workspace` |
| `clone`, `stream`, `projects`, `me`, `login`, `dev`, `example`, `template`, `version` | unchanged | — |

### Default-name derivation (exact rules, all client-side)

Precedence, highest first:

1. **`--project`** — validated against the tightened identifier grammar; on failure:
   `scratchwork publish: invalid project <name> (lowercase letters, digits, ".", "_", "-";
   must start and end with a letter or digit)`. Never slugified: explicit input is respected
   or rejected.
2. **`.scratchwork.json` `project`** — same validation; only from the publish root's own
   config (existing behavior). A file target's publish root is its containing directory, so
   a file and its siblings share that directory's saved project once one exists; a config
   above the resolved root contributes only the server, so a child directory can infer a new
   project instead of overwriting the ancestor's.
3. **Derived default** — directory target: `slugifyIdentifier(basename(dir), "")`;
   single-file target (**new**; replaces the current hard error at `publish.ts:314–317`):
   `slugifyIdentifier(stem(basename(file)), "")` where `stem` strips the final extension only
   (the substring after the last `.`, iff that dot is not at index 0 and a stem remains).
   Examples: `notes.md → notes`, `report.html → report`, `report.v2.md → report.v2`,
   `data.tar.gz → data.tar`, `.env → env`, `index.html → index` (predictable beats clever).
   Implement `stem` as a private helper in `publish.ts` — do **not** reuse `openPathForFile`
   (`cli/src/dev/target.ts`), which strips only `.html`/`.md` because it builds a servable
   route, not a name. Have `resolveProjectName` take the already-resolved target from
   `runPublish` instead of re-statting. The file target continues to bundle its containing
   directory (sibling assets, renderers, components) — literal one-file bundles would be a
   separate behavior change, out of scope.
4. **Derivation failure** (name slugifies to empty — e.g. `日本語/`, `!!!.md`): send **no**
   `project` field. A random-name server mints; a user-names server returns the 400, which the
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

`workspace` and `routePath` removed. **Legacy files fail loudly:** `decodeProjectConfig`
checks the raw parsed object for `workspace` / `routePath` keys and errors per §1
(explicitly naming which key(s) were found and what to do). Unknown keys *other than* those
two remain silently dropped (forward compatibility). The file is rewritten in the new schema
on the next successful publish. Note: the example projects' `.scratchwork.json` files are
**not in git** (`.gitignore` excludes them by policy) — they are stale local publish state,
regenerated by republishing. No fixture edits or `git rm` exist to be done here.

### File-by-file

- `cli/src/types.ts` — delete `PublishConfig.workspace` and `ProjectRefConfig.workspace`.
- `cli/src/index.ts` — delete both `workspace:` textOptions; `--project` help text →
  `"Project name for the published URL. Default: saved config, the directory name, or the
  file name without its extension. Servers that assign names return one on first publish."`;
  fix the delete-command description (still says "project pointer and route").
- `cli/src/api.ts` — `ResolvedProjectRef` → `{ server, project }`; `projectApiUrl` →
  `` `/api/projects/${encodeURIComponent(ref.project)}${suffix}` ``; **keep**
  `resolveProjectByPath`, decoding the project-only resolve response.
- `cli/src/project-config.ts` — drop `workspace`/`routePath` from `ProjectConfigFile` and add
  the legacy-key check to `decodeProjectConfig`; header prose → `--server/--project`.
  `resolveProjectRef`: explicit `--project` short-circuits; URL branch continues to call
  `/api/resolve` unless an explicit project already identifies the target; local branch falls
  back to `config.project`; missing → `scratchwork <cmd>: project is required`.
- `cli/src/commands/publish.ts` — `PublishResponse` → `{ project, visibility, openPath, url }`;
  drop workspace resolution and body field; `resolveProjectName` per the rules above;
  `writeMetadata` writes `{ server, project: response.project, visibility, url, updatedAt }`
  (response is authoritative); `decodePublishResponse` drops the workspace/routePath checks;
  `printResult` prints `project ${response.project}` and, when the sent name differs from
  `response.project`, appends `` `note    server assigned project name "${response.project}"` ``
  — this is how random-mode users learn their slug.
- `cli/src/commands/projects.ts` — `ApiProject` → `{ project, visibility, url?, updatedAt }`;
  listing line → `` `${project.project}\t${project.visibility}\t${project.url ?? `/${project.project}/`}` ``
  (keep the local fallback; it is one expression and risk-free); `Deleted ${ref.project}`;
  `Cloned ${ref.project} …`; fix the `runDelete` docstring ("pointer and route"). Continue
  validating the project name before using it as the clone destination directory.
  **`runClone` additionally writes `{ server, project }` as `.scratchwork.json` into the
  destination** — publish bundles exclude the root config, so a clone otherwise carries no
  identity, and republish identity would ride on the (renamable) directory name; on a
  random-name server a renamed clone would silently fork a new slug project. One touchpoint
  closes that hole.
- `cli/src/help.ts` — drop `--workspace` from all examples; notes → "server/project"; URLs
  single-segment; fix the delete-command note ("the route is removed from the server index"
  is stale); add one example each for inferred directory naming, inferred file-stem naming,
  and manual `--project` override; add one publish note: "On servers that assign random
  project names, the first publish returns the assigned name; it is saved to
  .scratchwork.json so republishes update the same project."
- No changes: `cli/src/auth.ts`, `browser.ts`, `errors.ts`, `renderer/`, `dev/**`,
  `commands/{dev,login,template,example}.ts` (all verified workspace-free; `stream` is
  transitively fixed via `resolveProjectRef`).

## 7. shared/ and renderer

- `shared/src/site/identifiers.ts` — delete `workspaceFromEmail` (sequenced **after**
  server/core stops importing it); tighten `isSafeProjectIdentifier` to
  `/^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/`; rewrite the header and docstrings to say
  "project identifier". `slugifyIdentifier` logic unchanged (already emits lowercase);
  callers pass `""` as the fallback and reject an empty result rather than the helper
  inventing a generic name.
- `shared/src/site/serve.ts` — comment example → single-segment prefix.
- Everything else in `shared/` and all of `renderer/` — no changes (verified). Optionally
  refresh the cookie-path comment in `renderer/src/main.js`.

## 8. Deletion inventory and do-not-touch list

Deleted outright, no successor: `workspaceFromEmail`; `ProjectRoutingMode`,
`DefaultWorkspaceMode`, `readProjectRoutingMode`, `readDefaultWorkspace`;
`routeDepth`, `safeRoutePath`; `ROUTES_NAMESPACE`, `RouteRecordSchema`, `RouteRecord`,
`projectKey`, `loadRouteRecord`, `putRouteRecord`, the route-claim rollback;
`defaultWorkspace()`, `requireUsableWorkspace()`, `workspaceExists()`,
`routePathForProject()`, `emailDomain()`, `loadPublishedSiteByRoute`; the `workspace` field
in every schema/type/response/config file; the `routePath` field everywhere; the three env
vars; both `--workspace` flags. (`readBoolean` survives — the new config knob uses it.
`/api/resolve` and `resolveProjectByPath` survive, project-only.)

**Do NOT touch** (bulk-grep hazards — never bulk-replace "workspace"): root `package.json`
`"workspaces"` (Bun monorepo config), `"workspace:*"` deps in `deploy/*/package.json`,
`bun.lock` / `cli/bun.lock` / `renderer/bun.lock` `"workspaces"` keys,
`server/package.json`'s description ("…server workspace commands" — npm-workspace sense),
heading-anchor "slug" code in `renderer/src/`, `shared/src/publish/bundle.ts`,
`shared/src/site/routing.ts`, `cli/src/dev/**`, `server/deploy-aws/src/**`,
`d1-db.ts`/`dynamodb-db.ts`/`s3-storage.ts`/`r2-storage.ts`, `server/scripts/env.ts`/`proc.ts`,
the uncommitted `notes/spec.md` homepage draft, and the three plan files in `notes/`.

## 9. Docs

- `README.md` → `scratchwork publish [path]` (+ a line showing `--project myproject`);
  saved-fields list → "`server`, `project`, `visibility`, and the latest URL"; document
  global project uniqueness, both inference rules, manual override, and server-assigned names.
- `notes/spec.md` (edit the committed text; see the preamble about the homepage draft):
  - **Concepts:** delete the workspace paragraph; add: a project has a globally unique name
    per server; the server either lets publishers choose names
    (`usersCanSetProjectNames: true`, first-writer-wins) or assigns a random slug on first
    publish (`false`). Note the lowercase name grammar and the reserved-prefix policy
    (including the grammar-level `_` reservation).
  - **Project Config:** new JSON example per §6; `server` + `project` are the portable
    identity fields; `workspace`/`routePath` gone; legacy keys are a hard error.
  - **Server Config:** replace the three knobs with `usersCanSetProjectNames: true` plus a
    comment covering both modes and the reserved names.
  - **CLI interface:** new default-name rule (directory name / file name minus extension —
    supersedes "the name of the project must be specified" for files); drop every
    `--workspace text`; project references become "server + project flags, project config, or
    a URL like `example.com/myproject/`"; note random-mode assignment on first publish.
  - **Security:** cookie scope `Path=/<project>` (token carries an explicit scope claim);
    single-segment clean URLs; reserved prefixes rejected as project names.
  - Homepage-draft rebase notes for its author: `homeProject` becomes one global project
    name; its publish command loses `--workspace`; the first-claim warning discusses the
    global name and `usersCanSetProjectNames`; an automatic-name deployment must publish
    first and then configure the returned slug, while a predeclared homepage should use
    user-set names.
- `docs/index.md`: no edit now (publishing section is a placeholder); future text must
  describe single-segment URLs and the two naming modes.

## 10. Execution sequence and cutover

Compile-dependency facts (verified): CLI imports only `shared/`, never `server/core`; deploy
scripts own their config type in `server/scripts/server-settings.ts`; CLI tests run against a
fake in-process server. So server and CLI can land in separate green commits. Known
mid-sequence state: between steps 2 and 5 the real CLI is runtime-incompatible with a
locally-run new server — tests stay green; don't manually publish in between. Commit
stepwise, **deploy atomically** (the protocol breaks both directions; no mixed versions —
an old CLI sends a rejected `workspace` field to the new server, and a new CLI against the
old server would create a project under an unintended default workspace).

1. **Step 0 — local-state hygiene.** `deploy/sndbx.sh/.scratchwork-local-data/` and the
   `examples/*/.scratchwork.json` files are untracked and already gitignored (verified).
   Delete or ignore them locally; they regenerate on republish. No git operations exist to
   be done.
2. **server/core (src + tests, one commit)** — §4 order, §11 tests.
3. **shared/** — §7 (now import-free).
4. **Deploy plumbing + deploy-project configs (one commit** — the type change and its
   consumers move together**)** — §5, plus the new deploy-setting tests (§11).
5. **CLI (src + tests, one commit)** — §6, §11.
6. **Docs** — §9.
7. **Verification + cutover.** Local (`deploy/local-dev`): publish a directory (default
   name), a single `.md` file (extension-strip; verify a sibling asset rides along and that a
   second sibling file reuses the saved project), a private project (cookie name/path/scope,
   handoff, 308 canonicalization, cross-project subresource isolation), a reserved name →
   400, an uppercase name → 400, a legacy `.scratchwork.json` with `workspace` → explicit CLI
   error; flip to `usersCanSetProjectNames: false` and verify mint + republish-by-slug + the
   assigned-name note + 409 on someone else's name. Live sndbx.sh: **wipe D1 rows and R2
   objects** (`wrangler d1 execute` DELETE + R2 purge) — the wipe is a hard prerequisite
   (owner-index decode hazard, §2); redeploy (rewrites Worker vars, dropping the three stale
   env vars); republish the example projects. No URL on the old two-segment scheme survives.
8. **Residue sweep (acceptance check).** Run
   `rg -n -i 'workspace' README.md notes cli shared server deploy --glob '!notes/remove-workspaces-*.md' --glob '!**/package.json' --glob '!**/bun.lock'`
   and review every hit: only deliberate negative tests for rejected legacy input/retired env
   vars may remain; runtime types, fields, flags, help, and product documentation must have
   none. Separately run `rg -n -i 'workspace' --glob '**/package.json' --glob '!**/bun.lock'`
   and verify every remaining hit is the root `workspaces` list, a `workspace:*` dependency,
   or the npm-sense description. Finally confirm no wire shape, persisted record, public URL,
   CLI flag/help text, deployment setting, or project-facing doc requires a workspace or
   exposes `routePath` as separate identity.

## 11. Tests

**`server/core/test/helpers.ts`** — config fixture: the three fields →
`usersCanSetProjectNames: true`.

**`server/core/test/app.test.ts`**
- Mechanical: drop `workspace` from every POST body and response assertion; paths
  `/demo/site/` → `/site/`; revision prefix `projects/site/revisions/`; `route=secret`;
  cookie `__Secure-scratchwork_access_secret`, `Path=/secret`; encoded-slash case `/si%2Fte` → 404.
- Delete: userDomain-mode test, `usersCanCreateWorkspaces` test, username-shadow half of the
  reserved test.
- Rework: `/api/resolve` test → project-only response shape; reserved test posts
  `project: "api" | "auth" | "gh" | "robots.txt"` → 400; random-workspace test →
  `usersCanSetProjectNames: false`: `published.project` matches `/^[a-z2-9]{10}$/`, `url`
  ends `/${published.project}/`.
- New: (a) cross-user collision — B publishing A's name → 409 with the exact canonical
  message; A's republish still 200; (b) create race → same 409, not the raw DB message;
  (c) random-mode republish — resending the returned slug updates in place; (d) **random-mode
  sent name owned by another user → 409** (never a fresh slug); (e) random-mode nonexistent
  sent name → fresh slug ≠ sent name; (f) user-names mode missing `project` → 400; (g) body
  containing `workspace: "demo"` → 400 (locks the hard break); (h) uppercase name → 400;
  (i) `/api/projects` list items carry `url`; (j) `GET /auth/project?route=` with
  empty/`..`/`%2E%2E` → 4xx, never 500 (same for `DELETE /api/projects/%2E%2E`).

**`auth.test.ts`** — defaults assert `usersCanSetProjectNames === true`; env tests →
`SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES=false` accepted, `=bogus` rejected with the exact
error string. Access-token tests: payload carries `project`, `scope === "/" + project`, and
`version === PROJECT_ACCESS_VERSION`; a payload with a different version fails verification;
old-format access cookies fail decode into a redirect, not a 500.

**`publish-request.test.ts`** — drop `workspace` from the happy path; `"Invalid workspace"`
case → `project: "../bad"` and `project: "Docs"` → `Invalid project`; excess-property case.

**`site-store.test.ts`** — `record()` fixture drops `workspace`/`routePath`, version 4;
delete the route-rollback test (mechanism gone), replace with the `ifNoneMatch`-conflict
test; add named-collision, same-owner-update, other-owner-denial (both modes), random
collision retry, and returned-random-name republish cases; `routePathForRequest` cases →
`projectForRequest` single-segment (keep `%2F` rejection and percent-decoding); `routeRest`
fixtures single-segment; garbage input to `loadProject` (`""`, `".."`) returns null.

**`db.test.ts`** — no change (keep slash-containing keys; owner-index keys still use `/`).

**Deploy-setting tests (new, per Codex):** focused tests around `serverConfigEnv`,
local-server mapping, and generated Cloudflare variables — the new setting must propagate,
and `SCRATCHWORK_PROJECT_ROUTING_MODE` / `SCRATCHWORK_DEFAULT_WORKSPACE` /
`SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES` must not appear. Add any new test file to
`server/package.json`'s `check` script (it currently names only `scripts/env.test.ts` before
running package tests). Optionally add the new var to the `worker.test.ts` fixture.
`handler.test.ts`, `env.test.ts`: no change.

**`cli/test/e2e.test.js`** (~16 workspace references): fake publish responses drop
`workspace`/`routePath` and use single-segment `url`; fake routes
`/api/projects/founder/site*` → `/api/projects/site*`; `/api/resolve` fakes become
project-only (kept, not deleted); `publishBody.workspace` assertions deleted; invocations
drop `--workspace founder`; `.scratchwork.json` fixtures drop `workspace`. New CLI tests:
file-stem naming table (`notes.md → notes`, `report.v2.md → report.v2`,
`data.tar.gz → data.tar`, extensionless file); `--project` wins; directory default;
underivable name → no `project` sent + friendly 400 mapping; **legacy config with
`workspace` or `routePath` key → explicit error naming the key** (not silent); clone writes
`{ server, project }`; assigned-name note printed when sent ≠ returned; random-server
lifecycle (first response differs from candidate; second publish sends the saved returned
slug); file-target regressions — `publish report.md` derives `report` while its bundle still
includes a sibling renderer/asset from the containing root, and publishing a second sibling
file later reuses the containing directory's saved project rather than inferring a second
identity.

**`cli/test/help.test.js`** — assert `--workspace` is absent from publish and
project-management help, and that `--project` plus the new defaults are documented.
(`auth.test.js`, `components.test.js` clean.)

## 12. Risks, ranked

1. **Cloudflare env allowlist (silent).** `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES` missing
   from `copyEnv` → Worker silently runs the default regardless of config. Step 4 bundles the
   type change with all consumers; the deploy-setting tests are the guard.
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
6. **Reserved names now hit CLI defaults.** A directory literally named `api`, `auth`, or a
   provider name like `google` derives a reserved name → server 400; the message should hint
   `--project`.
7. **Random-mode strays.** Deleting `.scratchwork.json` and republishing mints a duplicate
   project under a new slug. Accepted; `scratchwork projects` lists strays for cleanup; the
   clone config-write and the 409-on-unowned-name close the main silent paths.
8. **Bulk-grep collateral.** See the do-not-touch list (§8); the §10.8 residue sweep is the
   closing check.
9. **Spec collision.** §9's spec rewrite starts from the committed text; the uncommitted
   homepage draft must be rebased over it, not merged blind.
