# Scratchwork Server

Effect-native publishing server for `scratchwork publish`.

## Local

```sh
cd server
bun install
bun run start
```

By default the server listens on `3001` and stores published bundles under `.scratchwork-data/`.

## S3

```sh
SCRATCHWORK_STORAGE=s3 \
SCRATCHWORK_S3_BUCKET=my-bucket \
SCRATCHWORK_S3_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
bun run start
```

## R2

```sh
SCRATCHWORK_STORAGE=r2 \
R2_BUCKET=my-bucket \
R2_ACCOUNT_ID=... \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
bun run start
```

Set `SCRATCHWORK_PUBLIC_URL=https://your-host.example` behind a proxy so publish responses return the public URL.
