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
```

Set `SCRATCHWORK_PUBLIC_URL=https://your-host.example` behind a custom domain or proxy so publish responses return the public URL.
