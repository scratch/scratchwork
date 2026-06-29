# Scratchwork Server Packages

Effect-native publishing server for `scratchwork publish`.

The server is split into two packages:

1. `core`: platform-neutral HTTP app, config, storage contract, and local Bun runner
2. `deploy-cloudflare`: Cloudflare Worker adapter backed by R2

## Local

```sh
bun run server
```

By default the server listens on `3001` and stores published bundles under `.scratchwork-data/`.

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
