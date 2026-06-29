# Scratchwork Server Packages

Effect-native publishing server for `scratchwork publish`.

The server is split into three packages:

1. `core`: platform-neutral HTTP app, config, storage contract, and local Bun runner
2. `deploy-aws`: AWS Lambda Function URL adapter backed by S3
3. `deploy-cloudflare`: Cloudflare Worker adapter backed by R2

## Local

```sh
bun run server
```

By default the server listens on `3001` and stores published bundles under `.scratchwork-data/`.

## Google OAuth

Auth is disabled by default for local development. Enable the publish and viewing wall with Google OAuth:

```sh
SCRATCHWORK_AUTH=google
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-a-long-random-string
```

Deploy scripts load environment values from files and the shell. Precedence is:

1. Shell environment
2. Explicit `--env path/to/file`
3. Deploy package `.env`, such as `server/deploy-cloudflare/.env`
4. Shared `server/.env`
5. Built-in defaults

Start from the example file:

```sh
cp server/.env.example server/.env
```

Then deploy with either auto-loaded env files or an explicit file:

```sh
bun run deploy:aws
bun run deploy:cloudflare

bun run deploy:aws --env server/.env
bun run deploy:cloudflare --env server/.env
```

Configure your Google OAuth app with this redirect URI:

```txt
https://your-scratchwork-server.example/auth/callback/google
```

For local testing, use:

```txt
http://localhost:3001/auth/callback/google
```

Optional restrictions:

```sh
SCRATCHWORK_AUTH_ALLOWED_EMAILS=alice@example.com,bob@example.com
SCRATCHWORK_AUTH_ALLOWED_DOMAINS=example.com,yc.com
SCRATCHWORK_AUTH_SESSION_SECONDS=2592000
```

CLI users authenticate once per server:

```sh
scratchwork login --server https://your-scratchwork-server.example
scratchwork publish index.html
```

## AWS

Deploy to AWS Lambda + S3:

```sh
bun run deploy:aws
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
SCRATCHWORK_PUBLIC_URL=https://your-host.example
SCRATCHWORK_AUTH=google
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-a-long-random-string
```

## Cloudflare

Deploy to Cloudflare Workers + R2:

```sh
bun run deploy:cloudflare
```

The deploy command uses the `wrangler` CLI credentials in your environment. It creates the R2 bucket if needed, writes a generated Wrangler config under `server/deploy-cloudflare/dist/`, and deploys the Worker.

Optional environment variables:

```sh
SCRATCHWORK_CLOUDFLARE_WORKER_NAME=scratchwork-server
SCRATCHWORK_R2_BUCKET=scratchwork-sites
SCRATCHWORK_PUBLIC_URL=https://your-worker.example
SCRATCHWORK_CLOUDFLARE_SKIP_BUCKET_CREATE=1
SCRATCHWORK_AUTH=google
SCRATCHWORK_GOOGLE_CLIENT_ID=...
SCRATCHWORK_GOOGLE_CLIENT_SECRET=...
SCRATCHWORK_SESSION_SECRET=use-a-long-random-string
```

Cloudflare deploy writes non-secret auth values into the generated Wrangler config and uploads `SCRATCHWORK_GOOGLE_CLIENT_SECRET` plus `SCRATCHWORK_SESSION_SECRET` with `wrangler secret put`. AWS deploy sends `SCRATCHWORK_*` values to Lambda environment variables.

Set `SCRATCHWORK_PUBLIC_URL=https://your-host.example` behind a custom domain or proxy so publish responses return the public URL.
