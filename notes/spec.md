# Notes on the shared publishing model between CLI and the server

## Concepts

A **project** is a directory containing static files.

A **workspace** is a namespace for projects. Every project belongs to exactly one workspace. A workspace has a _name_ that may include `._-`

A **server** is a Scratchwork server.

A **user** is a unique user with access to a given Scratchwork server.

A **group** is the access expression used everywhere access is configured:

- `public` means anyone can access it.
- `private` means nobody matches the group by email; project ownership is checked separately.
- `@domain.com` means anyone authenticated with that email domain can access it.
- `user@example.com` means one specific authenticated user can access it.
- `user@x.com,@acme.com` means any matching email or domain can access it.

A project has a **visibility** group. This controls who can read the published project.

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
  "workspace": "...",
  "project": "...",
  "visibility": "private",
  "routePath": "...",
  "url": "https://pages.example.com/workspace/project/"
}
```

`server`, `workspace`, and `project` are the portable identity fields. `visibility` is the next publish default. `routePath` and `url` are server-assigned output fields saved by the CLI for display and convenience; they are not required to identify the project.

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

  // How projects map onto public route paths. Routing is deterministic: every route has
  // a fixed segment depth, so a request path resolves to at most one route. Must be one of:
  //   1. "workspace/project" - e.g. /pete/hello-world or /engineering/backlog
  //   2. "userDomain/workspace/project" - e.g. /example.com/pete/hello-world, where
  //      userDomain is the domain of the owner's email address
  projectRoutingMode: "workspace/project",

  // The workspace assigned to a published project when none is specified. Must be one of:
  //   "username" - the user's email local part (pete@example.com publishes to "pete")
  //   "random" - a random string of characters and numbers
  defaultWorkspace: "username",

  // Whether users can create new workspaces by publishing to them. When false, a publish
  // may only name a workspace that already exists or the user's own username workspace;
  // server-assigned default workspaces are always allowed.
  usersCanCreateWorkspaces: true,

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

  // D1 stores mutable project metadata, route indexes, and owner indexes.
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

  // DynamoDB stores mutable project metadata, route indexes, and owner indexes.
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
# workspace defaults to the user's personal workspace
# visibility defaults to the project config, then user default, then interactive prompt
# in non-interactive contexts with no user default, visibility defaults to private
# if path points to a directory, the name of the project defaults to the name of the directory
# if the path points to a file and the project name isn't found in .scratchwork.json,
# the name of the project must be specified
# if the server is specified (either in the args or project config) and the cli is not logged
# in to that server, scratchwork login <server> is automatically run first
# if the server is not specified, this command should error out
scratchwork publish [--server text] [--workspace text] [--project text] [--visibility <group>] [<path>]

# The following commands reference a project on the server. The project may be identified in one
# of three ways:
#   1. specifying the server, workspace, and project name via flags
#   2. specifying the path (default `.`) on disk to the project directory where
#      the server, workspace, and project name are specified in the project config file
#   3. a url, e.g. example.com/myworkspace/myproject/

# Unpublish a given project (make it visible to only the owner)
scratchwork unpublish [--server text] [--workspace text] [--project text] [<path-or-url>]

# Delete a given project
scratchwork delete [--server text] [--workspace text] [--project text] [<path-or-url>]

# clone this project in path/project
scratchwork clone [<path-or-url>]

# stream edits to the server
# project must be previously published
scratchwork stream [<path>]

# List my projects
scratchwork projects

# Info on a project
scratchwork info [--server text] [--workspace text] [--project text] [<path-or-url>]

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

To view a non-public project in the browser, a viewer needs a _project access cookie_ for that project. When a user requests a non-public project at its clean URL (`pages.example.com/<routePath>/...`), the content host redirects them to `app.example.com/auth/project?route=<routePath>&returnTo=<content-url>`, where they authenticate if needed via the `app.`-scoped session cookie. If their email matches the project `visibility` and the server `maxVisibility` ceiling, `app.` mints a **handoff token** — an HMAC-signed, ~60-second, single-purpose token bound to the project, route path, and viewer email — and redirects back to the content URL with the token in a reserved query parameter (`?_scratchwork_handoff=...`). The content host redeems it: it re-signs the same claims as a longer-lived **cookie token** (`authSessionSeconds`, matching the app session) and sets it as an `HttpOnly; Secure; SameSite=Lax` cookie scoped to `Path=/<routePath>`, then immediately redirects to the clean URL. The token never stays in the address bar, so the URL a viewer shares never carries a credential; a recipient who follows it just runs the same handoff under their own identity. An invalid or expired handoff token redirects to the clean URL, which re-runs the handoff.

Every private-content request re-verifies the cookie signature and re-checks `visibility`/`maxVisibility` against the cookie's email, so revoking access (unpublish, tightened visibility) takes effect immediately despite the long-lived cookie. The redirect dance only repeats when the cookie expires or access changes. Because the cookie is minted by the content host for its own hostname, the flow does not depend on `app.` and `pages.` sharing a registrable domain.

Without the sandbox, every project on `pages.` shares one web origin, so the server — not the browser — must keep one project's JavaScript from reading another project's private content with the viewer's ambient cookies. Private-content responses set `Referrer-Policy: same-origin`, and the content host rejects any private **subresource** request (`Sec-Fetch-Dest` present and not `document`: fetch/XHR, `<img>`, `<script>`, iframes, ...) whose `Referer` path is not inside the same project. `Referer` cannot be set or spoofed from scripts, in-project pages always send it under our referrer policy, and a request that strips it is refused — so a malicious project's fetches and iframes of another private project fail with 403, while a project referencing its own files works normally. Requests without `Sec-Fetch-Dest` (non-browser clients, old browsers) are treated as navigations. Unauthenticated subresource requests fail fast with 401 rather than redirecting into OAuth.

Two same-origin exposures remain by design and are accepted: a malicious project can `window.open` a private project (a user-visible popup; same-origin DOM reads are then possible), and origin-scoped browser storage (`localStorage`, IndexedDB) is shared across projects, so private pages should not persist secrets there. Deployments that need hard isolation between mutually untrusted publishers should serve projects from per-project origins instead; on a single-team server (`allowedUsers` limited to one org) the accepted exposures are between colleagues who can already log in.
