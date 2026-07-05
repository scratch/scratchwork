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

Every server requires OAuth — auth cannot be disabled. Configure Google OAuth credentials (including for local development):

```sh
SCRATCHWORK_AUTH=oauth  # optional; "oauth" is the only supported mode
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

CLI users authenticate once per server:

```sh
scratchwork login --server https://your-scratchwork-server.example
scratchwork publish index.html
```

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
