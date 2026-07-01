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
  "project": "..."
}
```

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

  // Authentication method (only "google" is supported, for now)
  auth: "google",

  // Optional auth restrictions. authAllowedDomains defaults to allowing only the admin to
  // authenticate. It can be set to a single domain or a list of domains and accepts wildcards,
  // e.g. *.example.com.
  authAllowedDomains: "example.com",
  authSessionSeconds: 2_592_000,

  // If shareAllowedDomains is set, users can only share published content with users on these
  // domains. If it is not set, there are no restrictions on who users can share with.
  shareAllowedDomains: None,

  usersCanCreateWorkspaces: false,
  defaultWorkspace:
} satisfies ScratchworkServerConfig;
```

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
} satisfies CloudflareDeployConfig;

await deployServer({ server, deploy } satisfies CloudflareDeployServerConfig, {
  envFile: ".env",
});
```

Cloudflare host assignment is part of `CloudflareDeployConfig`. Use `route` for one route pattern, `routes` for multiple hostnames/patterns, or `customDomain` for a Wrangler custom-domain binding.

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
} satisfies AwsDeployConfig;

await deployServer({ server, deploy } satisfies AwsDeployServerConfig, {
  envFile: ".env",
});
```

AWS host assignment is external to `AwsDeployConfig`. The deploy creates or reuses a public Lambda Function URL and returns it; custom domains for `appDomain` and `contentDomain` must be configured separately through CloudFront, API Gateway, DNS/proxying, or equivalent infrastructure.

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
# auth token is stored in ~/.scratchwork
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

## Default pub

A server can be configured to route a project to a default workspace:

random

## Security

### Authenticating

Users authenticate their cli using oauth in the browser or an API token. API Token can be obtained using the web dashboard or via the cli token.

Users authenticate to the app. domain using google oauth.

### Accessing a server

A server uses `allowedUsers` to limit who can authenticate to the app/API. It uses `maxVisibility` to limit how widely any project on that server can be shared. Both settings use the same group syntax as project `visibility`.

### Accessing content

The server exposes an API on the `app.` subdomain, and serves published projects on the `pages.` domain. This approach allows us to isolate API credentials from the arbitrary javascript that users can publish on `pages.`.

To view a non-public project in the browser, a user needs a _project access token_ for that project. When a user attempts to view a non-public project without a project access token, they are redirected to `app.` where they can authenticate if needed. Once authenticated, they're issued a session token, scoped to `app.`. If their email matches the project `visibility` and the server `maxVisibility` ceiling, they're issued an http-only, project-specific content token scoped to `pages.*/path/to/project` and then redirected back to the project.
