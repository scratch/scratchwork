# Notes on the shared publishing model between CLI and the server

## Concepts

A **project** is a directory containing static files.

A project has a **name** that is globally unique on its server. Names are lowercase: letters, digits, and interior `.`, `_`, `-`, with an alphanumeric first and last character, at most 128 characters. The server either lets publishers choose names (`usersCanSetProjectNames: true`, first-writer-wins) or assigns a random slug on the first publish (`false`); either way the name is the project's identity in URLs, the API, and the CLI. A set of reserved names (server routes such as `api` and `auth`, host-wide root files such as `robots.txt`, and prefixes held for future features) cannot be claimed; names starting with `_` or `.` are unclaimable by grammar.

A **server** is a Scratchwork server.

A **user** is a unique user with access to a given Scratchwork server.

A **group** is the access expression used everywhere access is configured:

- `public` means anyone can access it.
- `private` means nobody matches the group by email; project ownership is checked separately.
- `@domain.com` means anyone authenticated with that email domain can access it.
- `user@example.com` means one specific authenticated user can access it.
- `user@x.com,@acme.com` means any matching email or domain can access it.

A project has a **visibility** group. This controls who can read the published project.

A server may designate one project as its **homepage** — the project served on the server's home domains, typically the naked domain and `www`. The homepage is an ordinary project: it is published, updated, and access-controlled exactly like any other project. Only the way requests reach it differs. See "Server homepage" below.

## Project Config

Projects are configured via, in precedence order:

```sh
# Project config file in the project root
$PROJECT_ROOT/.scratchwork.json
```

A project config looks like this:

```json
{
  "server": "example.com",
  "project": "hello-world",
  "visibility": "private",
  "url": "https://pages.example.com/hello-world/",
  "updatedAt": "2026-07-04T00:00:00.000Z"
}
```

`server` and `project` are the portable identity fields. `visibility` is the next publish default. `url` and `updatedAt` are server-assigned output fields saved by the CLI for display and convenience; they are not required to identify the project. A config still carrying the retired `workspace` or `routePath` fields is a hard error: the CLI names the stale field and asks for the file to be fixed or deleted, then republished.

## Server Config

Server deploys are TypeScript projects that depend on one Scratchwork deploy package. The deploy package exports a `deployServer` function, a platform-neutral `ScratchworkServerConfig` type, and a provider-specific deploy config type.

`ScratchworkServerConfig` describes settings consumed by the running Scratchwork server, such as its public app/content hostnames and auth policy. The provider deploy config describes infrastructure used to run that server, such as the Cloudflare Worker/R2 resources or AWS Lambda/S3 resources.

Server hostnames and provider routing are separate. The server config hostnames are canonical public names used in generated URLs, OAuth redirects, cookies, and origin checks. They do not create DNS records or attach provider infrastructure to those names. The provider deploy config controls that binding.

Define server settings once, in a shared module, then pair them with whichever provider deploy config this target uses:

```ts
// server-config.ts
import type { ScratchworkServerConfig } from "@scratchwork/server-deploy-cloudflare";
// In an AWS-only deploy project, import this type from "@scratchwork/server-deploy-aws".

export const server = {
  // Canonical public hostnames for the dashboard/API and published content.
  // These do not assign provider infrastructure to the hostnames.
  appDomain: "app.example.com",
  contentDomain: "pages.example.com",

  // Optional server homepage: hostnames served from the homepage project, and
  // the globally unique name of that project. Set both or neither. The first
  // home domain is canonical; the others 308-redirect to it. Home domains must
  // be distinct from appDomain and contentDomain, and like those hostnames they
  // do not create DNS records or provider routing. See "Server homepage" below.
  homeDomains: ["example.com", "www.example.com"],
  homeProject: "home",

  // Authentication method. "oauth" is the only supported option; auth cannot be disabled.
  // Every server requires OAuth credentials, and every project has an owner.
  auth: "oauth",

  // Optional login/API restrictions. Uses the same group syntax as project visibility.
  // Defaults to "public" unless a deploy target sets a tighter value.
  allowedUsers: "@example.com",
  authSessionSeconds: 2_592_000,

  // Caps project visibility. A project cannot be published more broadly than this group.
  maxVisibility: "@example.com",

  // If shareAllowedDomains is set, users can only share published content with users on these
  // domains. If it is not set, there are no restrictions on who users can share with.
  shareAllowedDomains: undefined,

  // How new projects get their globally unique, server-wide name.
  //   true (default) - publishers choose names; the first publish of a name claims it
  //     (first-writer-wins), and anyone else publishing that name gets a 409.
  //   false - the server assigns a random slug on first publish; the CLI saves the
  //     returned name and uses it for updates.
  // Reserved names (api, auth, health, root files like robots.txt, and prefixes held
  // for future features such as gh/g and auth-provider names) are rejected either way.
  usersCanSetProjectNames: true,

  // Server fallback when the CLI does not send visibility.
  defaultVisibility: "private",
} satisfies ScratchworkServerConfig;
```

`authAllowedEmails` and `authAllowedDomains` are accepted as deploy-time aliases for `allowedUsers` while deploy configs are being migrated, but new configs should use `allowedUsers`.

For Cloudflare Workers + R2:

```ts
// deploy.ts
import {
  deployServer,
  type CloudflareDeployConfig,
  type CloudflareDeployServerConfig,
} from "@scratchwork/server-deploy-cloudflare";
import { server } from "./server-config";

const deploy = {
  workerName: "scratchwork-server",

  // These Wrangler routes assign the Worker to the Cloudflare hostnames.
  // DNS for the hostnames must exist in the Cloudflare zone.
  routes: [
    { pattern: "app.example.com/*", zoneName: "example.com" },
    { pattern: "pages.example.com/*", zoneName: "example.com" },
  ],

  // R2 stores immutable project bundles and rendered assets.
  r2Bucket: {
    name: "scratchwork-sites",
    binding: "SCRATCHWORK_R2",
  },

  // D1 stores mutable project metadata and owner indexes.
  d1Database: {
    name: "scratchwork-projects",
    binding: "SCRATCHWORK_D1",
  },
} satisfies CloudflareDeployConfig;

await deployServer({ server, deploy } satisfies CloudflareDeployServerConfig, {
  envFile: ".env",
});
```

Cloudflare host assignment is part of `CloudflareDeployConfig`. Use `route` for one route pattern, `routes` for multiple hostnames/patterns, or `customDomain` for a Wrangler custom-domain binding.

Cloudflare deploys bind both `SCRATCHWORK_R2` and `SCRATCHWORK_D1`. The deploy helper creates or reuses the R2 bucket and D1 database unless the corresponding skip flag is set.

For AWS Lambda + S3:

```ts
// deploy.ts
import {
  deployServer,
  type AwsDeployConfig,
  type AwsDeployServerConfig,
} from "@scratchwork/server-deploy-aws";
import { server } from "./server-config";

const deploy = {
  region: "us-east-1",
  functionName: "scratchwork-server",

  // AWS deploys create or reuse a public Lambda Function URL. They do not
  // create DNS records or custom-domain bindings for appDomain/contentDomain.
  // Put CloudFront, API Gateway, or another proxy in front separately if these
  // hostnames should point at the Lambda.

  // S3 stores immutable project bundles and rendered assets.
  s3Bucket: "scratchwork-sites",

  // DynamoDB stores mutable project metadata and owner indexes.
  dynamoDbTable: "scratchwork-projects",
} satisfies AwsDeployConfig;

await deployServer({ server, deploy } satisfies AwsDeployServerConfig, {
  envFile: ".env",
});
```

AWS host assignment is external to `AwsDeployConfig`. The deploy creates or reuses a public Lambda Function URL and returns it; custom domains for `appDomain` and `contentDomain` must be configured separately through CloudFront, API Gateway, DNS/proxying, or equivalent infrastructure. AWS deploys create or reuse the S3 bucket and DynamoDB table used by the server.

`deployServer` loads secrets from `process.env` and, optionally, a local env file passed as a deploy option. Environment variables override `.env` values. It fails before deploying if required secrets or deploy settings are missing. Secrets should not be committed in `deploy.ts`.

Example `.env` for built-in OAuth:

```sh
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-at-least-32-random-bytes
```

Cloudflare deploys also require Cloudflare credentials, and AWS deploys require AWS credentials; those are resolved through the same optional env file plus `process.env` path instead of being written into the TypeScript config.

Scratchwork uses the same group syntax for project-level and server-level access.

Project-level access is specified as `visibility`:

```json
{
  "visibility": "private"
}
```

The project owner can always access and update their project. Other users can view it only if their email matches the project's `visibility` group and the server's `maxVisibility` ceiling.

`allowedUsers` gates app/API login. `maxVisibility` caps project visibility, so a project cannot be more public than the server allows. For example, if `maxVisibility` is `"@example.com"`, a project cannot be published as `public`.

Write/admin access is owner-only in this model. A user who can log into the server can create and publish their own projects; they do not get write/admin rights on other users' projects through `visibility`.

## Server homepage

A server can serve a homepage project on its home domains — typically the naked domain and `www` — so a deployed server presents instructions, documentation, or a landing page at `https://example.com/`. The homepage is not a special kind of content: it is a normal project, published through the normal publish flow, stored and served through the same records, blobs, and rendering pipeline as every other project. The server config only designates which project it is and which hostnames serve it.

### Configuration

Two server config fields, set together (setting one without the other is a config error):

- `homeDomains` — the hostnames served from the homepage project. The first entry is the canonical home origin; requests to the other entries receive a 308 redirect to it. Home domains must be distinct from `appDomain` and `contentDomain`.
- `homeProject` — the globally unique name of the homepage project.

As with `appDomain` and `contentDomain`, these are canonical names consumed by the running server; they do not create DNS records or attach provider infrastructure. The provider deploy config must bind the home hostnames to the server — for Cloudflare, route patterns such as `example.com/*` and `www.example.com/*`; for AWS, external CloudFront/DNS configuration, the same as the other hostnames.

### Serving

The hostname determines which routing model applies:

- On the app domain, the server exposes auth and the API.
- On the content domain, the first path segment is the project name and a site's files are served under `/<project>/`.
- On a home domain, path-based project routing is disabled and the entire path space belongs to the homepage project: the full request path resolves as a file path inside `homeProject`, through the same serve pipeline (markdown rendering, extensionless HTML, index handling, default favicon).

This keeps routing deterministic — on any given host, a request path still resolves to at most one route. The reserved path prefixes keep their server-level behavior on every host, including home domains: `/auth/*` redirects to the app origin, and `/api/*` and `/health` are never served from project files. Homepage files under those prefixes are unreachable; everything else, including `/favicon.ico`, resolves within the project.

The homepage project also remains addressable at its normal content route (`pages.example.com/<project>/`). When the published project is the configured `homeProject`, the publish response and the saved project config report the canonical home origin as the project `url`.

Access control is unchanged: the homepage project has an owner and a `visibility` group, checked on every request under the server's `maxVisibility` ceiling. A non-public homepage runs the standard project-access handoff, with the access cookie scoped to `/` on the home origin. Because the home origin is separate from the content origin, homepage JavaScript does not share an origin with projects on the content domain, so the same-origin exposures described under Security do not extend across the two hosts. Most servers will want the homepage published as `public`.

### Publishing the homepage

There is no deploy-time publishing step. Deploys provision infrastructure only; the homepage arrives afterward through the ordinary publish flow, authenticated as a real user who then owns the project:

```sh
cd homepage/
scratchwork publish --server https://app.example.com \
  --project home --visibility public
```

Two affordances make this easy to get right:

- When `homeProject` is configured, the deploy output prints the exact publish command above, derived from the server config.
- Until the homepage project exists, requests to a home domain return a plain setup page carrying the same instructions, instead of the generic server banner. A freshly deployed server tells its own deployer how to finish setting it up.

Updating the homepage is a re-publish (or `scratchwork stream` while iterating); it never requires a redeploy. Changing which project is the homepage, or which hostnames serve it, is a config change and a redeploy, like any other server setting.

### Claiming the homepage name

The server does not reserve the `homeProject` name. On a server with open `allowedUsers` and `usersCanSetProjectNames: true`, the first user to publish a name owns it — including the configured homepage name. Deployers of open servers should publish the homepage promptly after the first deploy. On a server with `usersCanSetProjectNames: false` a name cannot be predeclared at all: publish the homepage first, then set `homeProject` to the returned slug and redeploy — a predeclared homepage really wants user-set names. If a stronger guarantee is needed later, a config-level owner restriction on the home project is a natural extension.

## Scratchwork CLI interface

```sh

# clone an example project in the specified directory
scratchwork example [<path>]

# serve the target directory or file locally with hot reload
scratchwork dev [(-p, --port integer)] [--verbose] [<path>]

# authenticate to the specified server
# auth token is stored in ~/.scratchwork/auth.json
# server must be specified unless it is found in .scratchwork.json in the current
# directory or a parent directory
scratchwork login <server>

# print the currently-logged-in
scratchwork me

# publish this project
# server must be specified unless it is found in .scratchwork.json in the current
# directory or a parent directory
# visibility defaults to the project config, then user default, then interactive prompt
# in non-interactive contexts with no user default, visibility defaults to private
# project name defaults, highest precedence first: --project, the publish root's
# .scratchwork.json, the directory name for a directory target, or the file name
# minus its final extension for a file target (notes.md -> notes); if nothing
# usable can be derived, --project is required
# on a server that assigns random names, the first publish returns the assigned
# name and the CLI saves it to .scratchwork.json so republishes update the same project
# if the server is specified (either in the args or project config) and the cli is not logged
# in to that server, scratchwork login <server> is automatically run first
# if the server is not specified, this command should error out
scratchwork publish [--server text] [--project text] [--visibility <group>] [<path>]

# The following commands reference a project on the server. The project may be identified in one
# of three ways:
#   1. specifying the server and project name via flags
#   2. specifying the path (default `.`) on disk to the project directory where
#      the server and project name are specified in the project config file
#   3. a url, e.g. example.com/myproject/

# Unpublish a given project (make it visible to only the owner)
scratchwork unpublish [--server text] [--project text] [<path-or-url>]

# Delete a given project (releases its name)
scratchwork delete [--server text] [--project text] [<path-or-url>]

# clone this project in path/project
scratchwork clone [<path-or-url>]

# stream edits to the server
# project must be previously published
scratchwork stream [<path>]

# List my projects
scratchwork projects

# Info on a project
scratchwork info [--server text] [--project text] [<path-or-url>]

```

## Security

### Authenticating

Users authenticate their CLI using OAuth in the browser. The CLI stores the returned bearer session token in `~/.scratchwork/auth.json` and sends it to the API as a bearer token. A separate long-lived API-token/dashboard flow is out of scope for the current implementation.

Users authenticate to the app. domain using google oauth.

### Accessing a server

A server uses `allowedUsers` to limit who can authenticate to the app/API. It uses `maxVisibility` to limit how widely any project on that server can be shared. Both settings use the same group syntax as project `visibility`.

### Accessing content

The server exposes an API on the `app.` subdomain, and serves published projects on the `pages.` domain. This approach allows us to isolate API credentials from the arbitrary javascript that users can publish on `pages.`.

Published pages are served with normal, unrestrictive policies — no `Content-Security-Policy: sandbox` — so published JavaScript behaves like an ordinary static site. Isolation from the API and the login session comes from the host split alone: the `app.` session cookie is host-bound and never visible to `pages.`.

To view a non-public project in the browser, a viewer needs a _project access cookie_ for that project. When a user requests a non-public project at its clean URL (`pages.example.com/<project>/...`), the content host redirects them to `app.example.com/auth/project?route=<project>&returnTo=<content-url>`, where they authenticate if needed via the `app.`-scoped session cookie. If their email matches the project `visibility` and the server `maxVisibility` ceiling, `app.` mints a **handoff token** — an HMAC-signed, ~60-second, single-purpose token bound to the project name, a path scope (normally `/<project>`, carried as its own claim so a future homepage alias can scope to `/`), and the viewer email — and redirects back to the content URL with the token in a reserved query parameter (`?_scratchwork_handoff=...`). The content host redeems it: it re-signs the same claims as a longer-lived **cookie token** (`authSessionSeconds`, matching the app session) and sets it as an `HttpOnly; Secure; SameSite=Lax` cookie scoped to `Path=/<project>`, then immediately redirects to the clean URL. The token never stays in the address bar, so the URL a viewer shares never carries a credential; a recipient who follows it just runs the same handoff under their own identity. An invalid or expired handoff token redirects to the clean URL, which re-runs the handoff.

Every private-content request re-verifies the cookie signature and re-checks `visibility`/`maxVisibility` against the cookie's email, so revoking access (unpublish, tightened visibility) takes effect immediately despite the long-lived cookie. The redirect dance only repeats when the cookie expires or access changes. Because the cookie is minted by the content host for its own hostname, the flow does not depend on `app.` and `pages.` sharing a registrable domain.

Without the sandbox, every project on `pages.` shares one web origin, so the server — not the browser — must keep one project's JavaScript from reading another project's private content with the viewer's ambient cookies. Private-content responses set `Referrer-Policy: same-origin`, and the content host rejects any private **subresource** request (`Sec-Fetch-Dest` present and not `document`: fetch/XHR, `<img>`, `<script>`, iframes, ...) whose `Referer` path is not inside the same project. `Referer` cannot be set or spoofed from scripts, in-project pages always send it under our referrer policy, and a request that strips it is refused — so a malicious project's fetches and iframes of another private project fail with 403, while a project referencing its own files works normally. Requests without `Sec-Fetch-Dest` (non-browser clients, old browsers) are treated as navigations. Unauthenticated subresource requests fail fast with 401 rather than redirecting into OAuth.

Two same-origin exposures remain by design and are accepted: a malicious project can `window.open` a private project (a user-visible popup; same-origin DOM reads are then possible), and origin-scoped browser storage (`localStorage`, IndexedDB) is shared across projects, so private pages should not persist secrets there. Deployments that need hard isolation between mutually untrusted publishers should serve projects from per-project origins instead; on a single-team server (`allowedUsers` limited to one org) the accepted exposures are between colleagues who can already log in.
