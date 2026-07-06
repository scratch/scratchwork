# Plan: remove publishing workspaces

## Outcome

Scratchwork publishing should have one identity: a project name that is unique across a server. A normal published URL becomes `https://pages.example.com/<project>/`, and every API, database, storage, CLI, and access-control path should address the project by that one name.

This plan deliberately removes the redundant route abstraction along with workspaces: when the project name is the public path segment, a persisted `routePath` and a separate route index add no value.

The following decisions make the target behavior unambiguous:

- “Globally unique” means unique among live projects on one Scratchwork server. Keep the existing identifier grammar and exact, case-sensitive matching; inferred and random names remain lowercase. Deleting a project releases its name, matching current delete behavior.
- Replace `projectRoutingMode`, `defaultWorkspace`, and `usersCanCreateWorkspaces` with one setting: `usersCanSetProjectNames` / `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`, defaulting to `true`.
- When `usersCanSetProjectNames` is `true`, a new publish must supply a project name. The name is claimed server-wide; another owner's existing name returns `409 Project name is already taken`, while the owner can republish it.
- When `usersCanSetProjectNames` is `false`, a supplied name identifies an existing owner-controlled project for republishing. If it does not exist, the server ignores it as a creation name and allocates a cryptographically random slug. An existing project owned by someone else returns the same `409 Project name is already taken` rather than silently creating a fork. Random allocation uses a bounded retry of the complete create operation when the conditional project-record write reports a name collision.
- The publish response is authoritative. The CLI always saves the returned project name, which is how a random-name server turns the first publish into stable subsequent updates.
- Publishing remains a name-based upsert rather than adding create/update intent to the protocol: if the requested name already belongs to the caller, publishing updates it even from a different local directory; callers use `--project` when an inferred basename would collide with one of their own projects. If a saved random project was deleted, the next publish creates a fresh random project and saves its new name.
- CLI project-name precedence is `--project`, then the publish root's saved `.scratchwork.json`, then an inferred name. For a file target the publish root is its containing directory, so the file-stem default applies only when that directory has no saved project. Infer a directory basename for a directory target and a file basename with only its final extension removed for a file target (`report.v2.md` becomes `report.v2`). Slugify inferred names; if nothing usable remains, ask for `--project` instead of falling back to the collision-prone name `project`.
- A file argument continues to use its parent as the publish root so sibling assets, renderers, and components are included. This change uses the file stem for naming; changing file targets to literal one-file bundles is a separate behavior change.
- Keep `/api/resolve`. It becomes project-only and uses fixed one-segment routing, but it still centralizes validation, authorization, and URL-to-project resolution for commands given a normal published URL. Resolving a future homepage URL needs a separate host-aware contract because the current CLI sends only its path.
- Do not touch Bun's monorepo `workspaces` field, `workspace:*` dependency versions, or lockfile workspace data. Those are package-manager concepts, not the publishing feature being removed.

## Target contract

| Surface | Current | Target |
| --- | --- | --- |
| Identity | `workspace/project` | `project` |
| Content URL | `/<workspace>/<project>/...` or configured three-segment route | `/<project>/...` |
| Publish request | `{ workspace?, project?, bundle, openPath, visibility? }` | `{ project?, bundle, openPath, visibility? }` |
| Publish response | `{ workspace, project, routePath, visibility, openPath, url }` | `{ project, visibility, openPath, url }` |
| Project API | `/api/projects/:workspace/:project` | `/api/projects/:project` |
| Project actions | `.../:workspace/:project/{bundle,unpublish}` | `.../:project/{bundle,unpublish}` |
| Resolve/list/info summaries | include `workspace` and `routePath` | include `project`; URL is derived from it |
| Local config | unversioned `server`, `workspace`, `project`, `routePath`, ... | `version: 1`, `server`, `project`, `visibility`, `url`, `updatedAt` |
| Project DB key | `<workspace>/<project>` | `<project>` |
| Owner-index key | `<owner>/<workspace>/<project>` | `<owner>/<project>` |
| Revision object | `projects/<workspace>/<project>/revisions/<id>.json` | `projects/<project>/revisions/<id>.json` |
| Route index | route path to workspace/project | removed |

## Implementation plan

### 1. Collapse shared naming and server configuration

- In `shared/src/site/identifiers.ts`, make the comments and helpers project-only. Keep `isSafeProjectIdentifier` and `slugifyIdentifier`; remove `workspaceFromEmail`. For inferred names, call `slugifyIdentifier(value, "")` and reject the empty result so the helper's current signature need not invent a generic fallback.
- In `server/core/src/access.ts`, stop re-exporting `workspaceFromEmail`. Apply the existing reserved-name check directly to project names (`api`, `auth`, `health`, `favicon.ico`, and `favicon.svg`). Visibility and ownership rules do not change.
- In `server/core/src/config.ts`, remove the routing/workspace types, fields, environment readers, and validation. Add `usersCanSetProjectNames: boolean`, read from `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`, with a default of `true` and the same strict boolean parsing used today.
- Clean the public exports in `server/core/src/index.ts`: remove workspace/routing types and helpers plus route-record/project-key exports that no longer exist; export the new config shape normally.
- In `server/scripts/server-settings.ts`, replace the three retired deploy settings with `usersCanSetProjectNames?: boolean` and map it to the new environment variable.

### 2. Flatten the publish request and persisted model

- In `server/core/src/publish-request.ts`, remove `workspace` from the public type, schema, and normalized result. Keep `project` optional at decode time because random-name creation can omit it; enforce whether creation requires or assigns a name in the store. Continue rejecting excess properties, making old clients that send `workspace` fail clearly as an incompatible protocol.
- In `server/core/src/site-records.ts`:
  - Remove `workspace` and `routePath` from `SiteRecord`, and bump its schema version.
  - Remove `workspace` from `SiteRevisionRecord`, and bump its schema version.
  - Reduce `OwnerProjectRecord` to `{ version, project }`, bumping its version.
  - Key project pointers by project name, owner entries by encoded owner plus project, and revision JSON by project plus revision ID.
  - Remove `ROUTES_NAMESPACE`, `RouteRecord`, its schema, and all route-record helpers. Content-addressed blob keys remain unchanged.
- In `server/core/src/site-store.ts`, change `loadProject`, `unpublish`, `deleteProject`, and `bundle` to accept one project name. Remove default-workspace selection, workspace existence checks, email-derived routing, route allocation, and route cleanup.
- Centralize name resolution in the publish flow:
  1. If the requested project already exists, require ownership and update it using the existing optimistic-concurrency behavior.
  2. If it does not exist and user-set names are enabled, require/validate the requested name, reject reserved names, and conditionally create the global project record.
  3. If it does not exist and user-set names are disabled, generate a random slug and conditionally create it. Retry only a project-key collision, not unrelated storage or database failures.
  4. Return the actual project name for both create and update.
- On a random-name collision, generate a fresh candidate and rebuild the revision and pointer for the complete create attempt. Because immutable revision JSON is written before the conditional pointer today, the losing attempt can leave an unreachable revision object under the collided prefix; accept this astronomically rare orphan as the same class of leak as a concurrent named-create race, and never attach it to the existing project.
- Rename `randomSlug` in `server/core/src/tokens.ts` to reflect project-name allocation. Keep Web Crypto randomness and the current unambiguous URL-safe alphabet; the slug is a stable random identifier, not a hash of mutable content.
- Preserve visibility defaults, owner-only writes, current-revision flipping, bundle export, listing pagination, and content-addressed blobs unchanged apart from their project-only keys.

### 3. Simplify routing, APIs, and private-project access

- In `server/core/src/routes.ts`, remove configurable route depth. Replace it with a helper that decodes and validates exactly the first nonempty path segment as the project name. Keep the path-remainder logic for resolving files beneath `/<project>/`, including encoded-slash rejection and the canonical trailing-slash redirect.
- In `server/core/src/app.ts`:
  - Parse `/api/projects/:project` plus the existing optional `bundle` and `unpublish` actions.
  - Remove workspace parameters and fields from every handler, publish result, summary, list, and resolve response.
  - Load content directly by the first project segment; do not consult a route index or routing mode.
  - Build published URLs from `contentBase + /<project> + openPath`.
  - Include the derived root URL in list summaries so the CLI does not need the removed `routePath` as a display fallback.
  - Keep `/api/resolve`, but return a project-only summary.
  - Change the private-content handoff query, canonicalization, referer guard, and cookie path calculations to use the project name as the normal route prefix.
- In `server/core/src/auth.ts`, replace the composite `projectKey` claim with the global project name, but retain a separate access-path scope claim. The normal scope is `/<project>`; keeping it distinct from identity allows a future homepage alias for the same project to use `/`. Version project-access payloads independently so old handoff/cookie tokens stop verifying without invalidating normal OAuth sessions or CLI bearer tokens.
- In `server/core/src/cookies.ts`, accept the derived access-path scope, use `Path=/<project>` for normal content, and simplify cookie naming/comments now that an ordinary route has one segment.
- Validate decoded project API segments before store access so malformed names produce a normal client error rather than becoming backend keys.

### 4. Make the CLI project-only and add both inference defaults

- In `cli/src/index.ts`, remove `--workspace` from `publish` and the shared `info`/`unpublish`/`delete` options. Rewrite `--project` help to describe the saved value, directory basename, and file-stem defaults, and note that an automatic-name server can return a different name.
- In `cli/src/types.ts`, remove `workspace` from `PublishConfig` and `ProjectRefConfig`.
- In `cli/src/commands/publish.ts`:
  - Remove workspace from the request, response decoder, metadata write, comments, and output.
  - Extend `resolveProjectName` to inspect the original target: basename for a directory, or `basename(file, finalExtension)` for a file. Preserve explicit/same-root saved precedence and explicit-name validation.
  - Treat the response's `project` as authoritative in output and `.scratchwork.json`.
  - Stop persisting redundant `routePath`.
- In `cli/src/project-config.ts`, give the new file format an explicit version and reduce project references and decoded config to server plus project (and the non-identity metadata). Reject unversioned legacy configs with an actionable remove/edit-and-republish error rather than decoding any old leaf project. Local project commands require only server and project. URL references continue to call `/api/resolve` unless an explicit project already identifies the target.
- In `cli/src/api.ts`, reduce `ResolvedProjectRef` to `{ server, project }`, build one-segment project API paths, and decode project-only resolve results.
- In `cli/src/commands/projects.ts`, remove workspace/route fields from API shapes. Render `<project>\t<visibility>\t<url>` for listings and project names alone in delete/clone messages. Continue validating the project before using it as the clone destination directory.
- In `cli/src/help.ts`, remove every workspace note, flag, example, and multi-segment URL. Add one example each for inferred directory naming, inferred file-stem naming, and manual `--project` override.
- Preserve the publish-root config rule. A config above the resolved root contributes only the server, so a child directory—or a file in a deeper containing directory—can infer a new project instead of overwriting the ancestor's project. A file and its siblings share their containing directory as the root and therefore share its saved project once one exists; the file-stem default is for the first publish from an unconfigured containing directory.

### 5. Update deployment adapters and concrete configs

- In `server/deploy-local/src/run.ts`, remove the old environment mappings and pass through `SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES`.
- In `server/deploy-cloudflare/src/deploy.ts`, remove the three retired variables from generated Wrangler configuration and add the new one.
- In `server/deploy-aws/src/deploy.ts`, the generic `SCRATCHWORK_*` forwarding will carry the new setting. Filter the retired routing/workspace variables when updating Lambda configuration so stale shell environment does not keep advertising dead settings.
- In `deploy/local-dev/local.ts`, remove routing configuration and set `usersCanSetProjectNames: true` explicitly for predictable local URLs.
- In `deploy/sndbx.sh/server-config.ts`, remove routing/workspace settings and set `usersCanSetProjectNames: true` to preserve its current friendly-name behavior. Switching this public-login deployment to random names is a separate operator/product decision; the new setting makes that a one-line change later.
- Update `server/deploy-local/README.md` and `server/README.md` with the one new setting, one-segment URLs, and the rule that a returned random name is used for updates.
- Change the product-facing description in `server/package.json` that says “workspace commands,” while leaving all package-manager workspace declarations untouched.

### 6. Make the rollout intentionally breaking

There is no safe automatic flattening: `alpha/docs` and `beta/docs` can coexist today but both map to `docs`. Use a coordinated server-and-CLI cutover rather than dual routing or compatibility shims.

- In the existing D1/DynamoDB resource, use new mutable namespaces such as `projects-v2` and `projects-by-owner-v2` for the project-only pointer and owner index. This keeps old record versions out of new list/read paths without provisioning new cloud databases; leave the old `projects`, `projects-by-owner`, and `routes` rows inert.
- Do not migrate old project pointers or revision metadata in the main change. Existing content-addressed blobs may remain in object storage, but users republish projects into the new namespace. If production retention becomes a requirement, make it a separate operator-approved migration with an explicit old-pair-to-new-name manifest; never resolve duplicate leaf names automatically.
- Do not silently reinterpret old `.scratchwork.json` coordinates. Require the new config format version; treat existing unversioned files as legacy and fail with an actionable instruction to remove/edit the config and republish with a globally unique `--project`. This avoids retaining a workspace-specific compatibility check in the steady-state CLI.
- Accept that old public URLs and project API URLs break. A fallback parser is ambiguous because `/workspace/project/file` now legitimately means file `project/file` inside a project named `workspace`.
- Old project-access cookies naturally stop applying because both their token schema and cookie path change; normal login sessions remain valid.
- Roll out under a publish maintenance window: stop writes, deploy the new server against the new namespaces, make the matching CLI available, clear or repair legacy local configs, and only then resume publishing. Do not support mixed versions: an old CLI sends a rejected `workspace` field to the new server, while a new CLI talking to the old server could create a project under an unintended default workspace.

### 7. Update documentation without losing current work

- In `README.md`, remove `--workspace`, document global project uniqueness, both inference rules, manual override, and server-assigned names. Update the `.scratchwork.json` field list.
- Rewrite the publishing model, config, API/CLI examples, URL grammar, and security prose in `notes/spec.md` to use a single project name. Preserve the user's current uncommitted homepage edits while doing this later:
  - `homeProject` becomes one global project name.
  - Its publish command loses `--workspace`.
  - The first-claim warning discusses the global name and `usersCanSetProjectNames`.
  - An automatic-name deployment must publish first and then configure the returned slug, while a predeclared homepage should use user-set names.
- `docs/index.md` and the authored examples have no publishing-workspace contract and need no conceptual rewrite.

## Test plan

- `server/core/test/publish-request.test.ts`: remove workspace assertions; cover project validation, random-mode omission, and rejection of an obsolete `workspace` property.
- `server/core/test/auth.test.ts`: replace routing/workspace config tests with default, explicit true/false, and invalid `usersCanSetProjectNames` cases; cover the new project-access payload version.
- `server/core/test/helpers.ts`: make the default fixture project-only and replace the three removed config fields.
- `server/core/test/site-store.test.ts`: update record versions and one-segment path fixtures; replace route-index rollback coverage with global conditional-claim behavior. Add named collision, same-owner update, other-owner denial, random collision retry, and returned-random-name republish cases.
- `server/core/test/app.test.ts`: convert all requests, responses, storage keys, API URLs, content URLs, redirects, referers, cookies, and cross-project checks to one segment. Replace random-workspace/domain-routing/workspace-creation tests with the two project-naming policies. Keep visibility, auth, rendering, pagination, and revision-flip assertions.
- `cli/test/e2e.test.js`: update mocks, configs, endpoints, URLs, and output to project-only forms. Add coverage for directory inference, a multi-dot file stem, an extensionless file, `--project` override, unusable inferred names, versioned-config rejection of a legacy file, and automatic-server lifecycle (first response differs from candidate; second publish sends the saved returned slug). Add file-target regressions asserting that `publish report.md` derives `report` while its bundle still includes a sibling renderer/asset from the containing root, and that publishing a second sibling file later reuses the containing directory's saved project rather than inferring a second identity.
- `cli/test/help.test.js`: assert `--workspace` is absent from publish and project-management help, and that `--project` plus the new defaults are documented.
- Add focused deploy-setting tests around `serverConfigEnv`, local-server mapping, and generated Cloudflare/AWS variables: the new setting must propagate, and `SCRATCHWORK_PROJECT_ROUTING_MODE`, `SCRATCHWORK_DEFAULT_WORKSPACE`, and `SCRATCHWORK_USERS_CAN_CREATE_WORKSPACES` must not. Add the new test file to `server/package.json`'s `check` script, which currently names only `scripts/env.test.ts` before running package tests.
- Keep adapter DB/storage tests unless schema fixtures mention the removed fields; the adapters themselves are generic key/value implementations.

## Verification and acceptance criteria

1. Run `bun run check` and the repository typecheck after updating all packages and deploy configs.
2. Smoke-test a name-enabled server: directory inference, file-stem inference, explicit override, republish, list/info/unpublish/delete/clone, and a collision between two users.
3. Smoke-test an automatic-name server: first publish returns a random slug, `.scratchwork.json` saves it, and publish/stream updates the same project thereafter.
4. Verify public and private content at `/<project>/...`, including handoff redirects, project-scoped cookies, same-project assets, and cross-project subresource rejection.
5. Run `rg -n -i 'workspace' README.md notes cli shared server deploy --glob '!notes/remove-workspaces-codex.md' --glob '!**/package.json' --glob '!**/bun.lock'` and review every hit. Only deliberate negative tests for rejected legacy input/retired environment variables may remain; runtime types, fields, flags, help, and product documentation must have none. Separately run `rg -n -i 'workspace' --glob '**/package.json' --glob '!**/bun.lock'` and verify every remaining hit is the root `workspaces` list or a `workspace:*` dependency, not product prose.
6. Confirm no wire shape, persisted record, public URL, CLI flag/help text, deployment setting, or project-facing documentation requires a workspace or exposes `routePath` as separate identity.
