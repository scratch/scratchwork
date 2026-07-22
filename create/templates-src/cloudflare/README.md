# Scratchwork server on Cloudflare

A self-hosted [Scratchwork](https://github.com/scratch/scratchwork) publishing
server, deployed as a Cloudflare Worker backed by R2 (published content) and
D1 (project metadata).

## Configure

1. Edit `server-config.ts` — your domains and auth policy. The scaffolded
   values are `example.com` placeholders.
2. Edit `cloudflare-config.ts` — Worker name, R2 bucket, D1 database, zone,
   and routes.
3. Copy `.env.example` to `.env` and fill in the Cloudflare API token and the
   auth secrets (the comments in `.env.example` explain each value).

Configure your Google OAuth app with the redirect URI
`https://<your app domain>/auth/callback/google`.

## Run locally

```sh
bun install
bun run local
```

This runs the same Worker locally with Wrangler's persistent R2 and D1
simulations (state lives under `.scratchwork-cloudflare-data/`). To complete a
browser login locally, add `http://localhost:8787/auth/callback/google` as a
second redirect URI on the Google OAuth client. Set `PORT` to change the port.

## Deploy

```sh
bun run deploy
```

This creates or updates the R2 bucket, D1 database, Worker, bindings, and
routes through the Cloudflare API. Then publish to your server with the
[Scratchwork CLI](https://github.com/scratch/scratchwork):

```sh
scratchwork publish --server https://<your app domain>
```
