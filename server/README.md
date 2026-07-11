# Scratchwork Server Packages

Effect-native publishing server for `scratchwork publish`.

The server is split into four packages:

1. `core`: platform-neutral HTTP app, config, and storage contract
2. `deploy-aws`: AWS Lambda Function URL adapter backed by S3
3. `deploy-cloudflare`: Cloudflare Worker adapter backed by R2
4. `deploy-local`: local Bun adapter backed by local files and an in-memory database

These packages are libraries. Actual deployments live as projects under `deploy/` — one per domain the Scratchwork project owns (currently `deploy/sndbx.sh`), plus `deploy/local-dev` (local-only development server) and `deploy/generic-aws` (a placeholder AWS deploy).

## Local

```sh
bun run local:local-dev
```

By default the server listens on `43118` and stores published bundles under `.scratchwork-local-data/`. Every deploy project can also run its own server config locally via `deploy-local`'s `runLocalServer` (for example `bun run local:sndbx.sh`) — see `server/deploy-local/README.md`.

## Google OAuth

Every server requires auth — it cannot be disabled, and `SCRATCHWORK_AUTH` must choose the mode explicitly: built-in Google OAuth (`oauth`) or Cloudflare Access (`cloudflare-access`, see below). Configure Google OAuth credentials (including for local development):

```sh
SCRATCHWORK_AUTH=oauth
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-at-least-32-random-bytes
```

Deploy projects load environment values from files and the shell. Precedence is:

1. Shell environment
2. The project's `.env`, such as `deploy/sndbx.sh/.env`
3. Built-in defaults

Start from the project's example file, then deploy:

```sh
cp deploy/sndbx.sh/.env.example deploy/sndbx.sh/.env
bun run deploy:sndbx.sh
```

Configure your Google OAuth app with this redirect URI:

```txt
https://your-scratchwork-server.example/auth/callback/google
```

For local testing, use:

```txt
http://localhost:43118/auth/callback/google
```

Optional restrictions:

```sh
SCRATCHWORK_AUTH_ALLOWED_EMAILS=alice@example.com,bob@example.com
SCRATCHWORK_AUTH_ALLOWED_DOMAINS=example.com,yc.com
SCRATCHWORK_AUTH_SESSION_SECONDS=2592000
```

Project naming:

```sh
# true (default): publishers choose globally-unique project names (first-writer-wins).
# false: the server assigns a random slug on first publish; the CLI saves the returned
# name in .scratchwork.json and uses it for updates.
SCRATCHWORK_USERS_CAN_SET_PROJECT_NAMES=true
```

Server homepage (optional, set both together): serve one ordinary project across the
whole path space of the server's home domains. The first domain is canonical; the
others 308-redirect to it. Keep them distinct from the app and content hosts.

```sh
SCRATCHWORK_HOMEPAGE_DOMAINS=example.com,www.example.com
SCRATCHWORK_HOMEPAGE_PROJECT=home
```

CLI users authenticate once per server:

```sh
scratchwork login --server https://your-scratchwork-server.example
scratchwork publish index.html
```

## Cloudflare Access

When the server's domains are served through Cloudflare with a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application in front of them, the server can delegate authentication to Access instead of running OAuth itself:

```sh
SCRATCHWORK_AUTH=cloudflare-access
SCRATCHWORK_CF_ACCESS_TEAM_DOMAIN=myteam   # or myteam.cloudflareaccess.com
SCRATCHWORK_CF_ACCESS_AUD=...              # the Access application's Audience (AUD) tag
SCRATCHWORK_SESSION_SECRET=use-at-least-32-random-bytes
```

Both values come from the Cloudflare Zero Trust dashboard (the AUD tag is on the Access application's overview page). No Google credentials are needed. `SCRATCHWORK_SESSION_SECRET` is still required: it signs the CLI bearer tokens and the private-content handoff tokens.

Cloudflare authenticates every user at the edge and injects a signed JWT into each request (`Cf-Access-Jwt-Assertion`); the server verifies it against the team's public keys and the AUD tag, and uses the asserted email as the user identity. `SCRATCHWORK_ALLOWED_USERS` still applies on top of the Access policy. Browser login is transparent (there is no `/auth/callback` round-trip), and `/auth/logout` redirects to Cloudflare's `/cdn-cgi/access/logout`.

Things to know when setting up the Access application:

- Cover the app domain (and any private content domains) with the Access application. Do **not** put a domain that serves public projects behind Access, or anonymous visitors will be blocked at the edge before the server can serve them.
- `scratchwork login` works unchanged: the browser passes Access, and the server converts the asserted identity into the CLI's bearer token. The login redirect also relays the browser's verified Access JWT; the CLI stores it and sends it back as a `cf-access-token` header on every API request, which Cloudflare's edge accepts as an Access credential — so CLI requests pass the edge with no extra Access configuration.
- The relayed JWT expires with the Access application's **session duration** (default 24 hours) — much shorter than the CLI's bearer token. When it expires, CLI commands fail with a prompt to run `scratchwork login` again; configure a longer session duration on the Access application to keep re-logins rare.
- For CI and headless automation, create an Access [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) and set `SCRATCHWORK_CF_ACCESS_CLIENT_ID` and `SCRATCHWORK_CF_ACCESS_CLIENT_SECRET` in the environment; the CLI attaches them as `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers so requests pass the edge. Service tokens only satisfy the edge — the server still identifies the user by the bearer token, so the machine must have a stored login.
- Older CLIs that predate the token relay cannot pass the edge on API calls. For those, either add an Access bypass policy for `/api/*` (safe: the server still requires its own bearer token there), or have CLI users authenticate to Access themselves (e.g. with `cloudflared`) — the server accepts a valid `Cf-Access-Jwt-Assertion` (or `cf-access-token`) header on API calls.

## AWS

Deploy to AWS Lambda + S3 via the placeholder `deploy/generic-aws` project (kept around in case we invest more in AWS deploy capabilities):

```sh
bun run deploy:generic-aws
```

The deploy command uses the AWS CLI credentials in your environment. It creates or updates:

1. An S3 bucket for site records
2. An IAM role with Lambda logs and bucket read/write permissions
3. A Node.js 20 Lambda function
4. A public Lambda Function URL

Optional environment variables:

```sh
AWS_REGION=us-east-1
SCRATCHWORK_AWS_FUNCTION_NAME=scratchwork-server
SCRATCHWORK_AWS_ROLE_NAME=scratchwork-server-lambda-role
SCRATCHWORK_S3_BUCKET=my-existing-bucket
SCRATCHWORK_APP_URL=https://your-host.example
SCRATCHWORK_CONTENT_URL=https://your-host.example
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-at-least-32-random-bytes
```

## Cloudflare

Deploy to Cloudflare Workers + R2 via a deploy project, such as `deploy/sndbx.sh`:

```sh
bun run deploy:sndbx.sh
```

The deploy command uses the `wrangler` CLI credentials in your environment. It creates the R2 bucket if needed, writes a generated Wrangler config under `server/deploy-cloudflare/dist/`, and deploys the Worker.

Optional environment variables:

```sh
SCRATCHWORK_CLOUDFLARE_WORKER_NAME=scratchwork-server
SCRATCHWORK_R2_BUCKET=scratchwork-sites
SCRATCHWORK_APP_URL=https://your-worker.example
SCRATCHWORK_CONTENT_URL=https://your-worker.example
SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE=1
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-at-least-32-random-bytes
```

Cloudflare deploy writes non-secret auth values into the generated Wrangler config and uploads `SCRATCHWORK_GOOGLE_CLIENT_SECRET` plus `SCRATCHWORK_SESSION_SECRET` with `wrangler secret put`. AWS deploy sends `SCRATCHWORK_*` values to Lambda environment variables.

Set `SCRATCHWORK_APP_URL` and `SCRATCHWORK_CONTENT_URL` (or the `appDomain`/`contentDomain` config values) behind a custom domain or proxy so publish responses return the public URL. Use the same value for both on a single-host server.
