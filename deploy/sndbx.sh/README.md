# sndbx.sh Cloudflare deploy

This deploy instance is a Bun project that uses the shared Cloudflare Worker
deploy package.

Deploy from the repo root:

```sh
bun run deploy:sndbx.sh
```

Start local secrets from the template:

```sh
cp deploy/sndbx.sh/.env.example deploy/sndbx.sh/.env
```

The domain settings live in `deploy.ts`. Secrets are read from `.env` in this
directory and the shell environment; this deploy project does not read
`server/.env`. It binds the Worker with routes for `app.sndbx.sh/*` (app/API/auth),
`pages.sndbx.sh/*` (published content), and the legacy `www.sndbx.sh/*` and
`sndbx.sh/*` routes. The Worker name is `scratchwork`, matching the existing
Cloudflare route assignment for those hostnames.

Configure the Google OAuth redirect URI as:

```txt
https://app.sndbx.sh/auth/callback/google
```
