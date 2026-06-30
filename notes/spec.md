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

Server deploys are TypeScript projects that depend on one Scratchwork deploy package. The deploy package exports a `deployServer` function and a config type for its target platform.

For Cloudflare Workers + D1 + R2:

```ts
// deploy.ts
import {
  deployServer,
  type CloudflareServerConfig,
} from "@scratchwork/server-deploy-cloudflare";

const config = {
  appDomain: "app.example.com",
  contentDomain: "pages.example.com",

  // Who can publish content to this server.
  allowedUsers: "@example.com",

  // Most-permissive visibility any project on this server may use.
  maxContentVisibility: "@example.com",

  // "built-in" uses Scratchwork OAuth. "cloudflare-access" trusts Cloudflare Access.
  authMode: "built-in",

  // Maximum zipped project size, in megabytes.
  maxProjectSizeMB: 25,

  workerName: "scratchwork-server",

  // D1 stores users, projects, permissions, deploy metadata, and live pointers.
  d1Database: {
    name: "scratchwork-records",
    binding: "SCRATCHWORK_DB",
    tableName: "scratchwork_records",
  },

  // R2 stores immutable project bundles and rendered assets.
  r2Bucket: {
    name: "scratchwork-sites",
    binding: "SCRATCHWORK_R2",
  },
} satisfies CloudflareServerConfig;

await deployServer(config, { envFile: ".env" });
```

For AWS Lambda + DynamoDB + S3:

```ts
// deploy.ts
import {
  deployServer,
  type AwsServerConfig,
} from "@scratchwork/server-deploy-aws";

const config = {
  appDomain: "app.example.com",
  contentDomain: "pages.example.com",
  allowedUsers: "@example.com",
  maxVisibility: "@example.com",
  authMode: "built-in",
  maxProjectSizeMB: 25,

  region: "us-east-1",
  functionName: "scratchwork-server",

  // DynamoDB stores users, projects, permissions, deploy metadata, and live pointers.
  dynamoDbTable: {
    name: "scratchwork-records",
    partitionKey: "namespace",
    sortKey: "key",
  },

  // S3 stores immutable project bundles and rendered assets.
  s3Bucket: "scratchwork-sites",
} satisfies AwsServerConfig;

await deployServer(config, { envFile: ".env" });
```

`deployServer` loads secrets from `process.env` and, optionally, a local env file passed as a deploy option. Environment variables override `.env` values. It fails before deploying if required secrets are missing, or if the config does not match the exported config type's runtime schema. Secrets should not be committed in `deploy.ts`.

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
scratchwork publish [--server text] [--workspace text] [--project text] [--visibility <group>] [<path>]

# clone this project in path/project
scratchwork clone <server.com/path/to/project> [<path>]

# stream edits to the server
# project must be previously published
scratchwork stream [<path>]
```

## Default workspace

A server can be configured to route a project to a default workspace:

## Security

### Authenticating

Users authenticate their cli using oauth in the browser or an API token. API Token can be obtained using the web dashboard or via the cli token.

Users authenticate to the app. domain using google oauth.

### Accessing a server

A server uses `allowedUsers` to limit who can authenticate to the app/API. It uses `maxVisibility` to limit how widely any project on that server can be shared. Both settings use the same group syntax as project `visibility`.

### Accessing content

The server exposes an API on the `app.` subdomain, and serves published projects on the `pages.` domain. This approach allows us to isolate API credentials from the arbitrary javascript that users can publish on `pages.`.

To view a non-public project in the browser, a user needs a _project access token_ for that project. When a user attempts to view a non-public project without a project access token, they are redirected to `app.` where they can authenticate if needed. Once authenticated, they're issued a session token, scoped to `app.`. If their email matches the project `visibility` and the server `maxVisibility` ceiling, they're issued an http-only, project-specific content token scoped to `pages.*/path/to/project` and then redirected back to the project.
